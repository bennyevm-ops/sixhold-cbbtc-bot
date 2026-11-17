/**
 * SixHold - a patient cbBTC paper-trading bot for the make.fun 24h BTC race.
 *
 * Protocol: agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout).
 * One JSON line per minute carries a 1-minute bar of cbBTC priced in USDC from
 * its Orca Whirlpool on Solana; the bot answers each batch with buy/sell
 * orders. Orders fill at the next bar's open with a 4 bps fee, 2 bps of
 * modelled slippage and constant-product price impact against the pool's
 * depth, so every round trip at full size costs roughly a third of a percent.
 * The bot starts with 1,000 USDC of paper money. Nothing here trades for real.
 *
 * Strategy (written for this race, tuned on the published dev window):
 *   Fee drag is the enemy, so the bot trades as rarely as possible:
 *   1. First tranche (~52% of cash) as soon as the 20-minute momentum is not
 *      negative - the market is not falling - instead of waiting for a
 *      perfect signal and paying for the delay.
 *   2. Second tranche (~88% of the remaining cash) either on a confirmed dip
 *      (price at least 0.6% under the first entry and turning back up) or, if
 *      no dip comes within ~7 hours, once the 60-minute momentum is positive.
 *   3. Exits are deliberately hard to trigger: a disaster exit only when the
 *      price breaks 1.8% below its 240-minute EMA with 60-minute momentum
 *      under -0.4% (or a flat -3% stop before the EMA exists), and a profit
 *      lock that arms above +2.0% and trails 0.75% under the peak.
 *   4. After any exit the bot waits 180 bars before it may re-enter, so chop
 *      cannot churn it into fee bleed.
 *
 * Everything is a deterministic function of the bars received: no clock, no
 * network, no files, no randomness. Two runs on the same data place the same
 * orders byte for byte. Node 22, no dependencies.
 */

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 500;

// Strategy parameters (fractions are of price / cash, windows in bars).
const WARMUP_BARS = 30; // bars of history before the first decision
const ENTRY_MOM20_MIN = -0.0002; // first tranche needs 20m momentum >= -0.02%
const TRANCHE1_FRACTION = 0.52; // of current cash
const TRANCHE2_FRACTION = 0.88; // of remaining cash
const DIP_DEPTH = 0.006; // dip tranche: price <= entry * (1 - 0.6%)
const LATE_BARS = 420; // no dip by then: complete on positive 60m momentum
const EMA_WINDOW = 240; // 4-hour EMA for the disaster exit
const BREAK_DEPTH = 0.018; // disaster exit: close < EMA * (1 - 1.8%)
const BREAK_MOM60 = -0.004; // ... with 60m momentum below -0.4%
const EARLY_STOP = 0.03; // before the EMA exists: flat -3% stop off entry
const LOCK_GAIN = 0.02; // profit lock arms above +2.0%
const LOCK_TRAIL = 0.0075; // ... and trails 0.75% under the peak close
const COOLDOWN_BARS = 180; // bars to sit out after any exit
const MIN_NOTIONAL = 1_000_000; // 1 USDC in quote units

type Json = Record<string, unknown>;

class Bot {
  priceScale: number;
  warmupBars: number;
  closes: number[] = [];
  ema: number | null = null;
  stage = 0; // 0 flat, 1 first tranche in, 2 complete
  entryRef = 0; // close at the first-tranche decision
  peakClose = 0; // highest close while holding
  cooldown = 0; // bars left to sit out after an exit
  orderSeq = 0;

  constructor(hello: Json) {
    const symbols = hello["symbols"] as Json[];
    const mine = symbols.find((s) => s["symbol"] === SYMBOL) as Json;
    this.priceScale = mine["price_scale"] as number;
    this.warmupBars = (hello["warmup_bars"] as number | undefined) ?? 0;
  }

  clientId(): string {
    this.orderSeq += 1;
    return "s" + this.orderSeq;
  }

  price(raw: string): number {
    return Number(raw) / 10 ** this.priceScale;
  }

  onBatch(batch: Json): Json[] {
    const bars = batch["bars"] as Json[];
    const bar = bars.find((b) => b["symbol"] === SYMBOL);
    if (!bar) return [];
    const close = this.price(bar["c"] as string);
    this.closes.push(close);
    this.ema =
      this.ema === null
        ? close
        : this.ema + ((close - this.ema) * 2) / (EMA_WINDOW + 1);
    if (this.cooldown > 0) this.cooldown -= 1;

    const account = batch["account"] as Json;
    const cash = Number(account["cash_quote_units"]);
    let heldQty: string | null = null;
    for (const p of account["positions"] as Json[]) {
      if (p["symbol"] === SYMBOL) heldQty = p["qty"] as string;
    }
    const holding = heldQty !== null && heldQty !== "0";
    if (holding) {
      this.peakClose = Math.max(this.peakClose, close);
      if (this.stage === 0) this.stage = 1;
    } else {
      this.stage = 0;
    }

    const k = this.closes.length - 1; // index of the bar just closed
    if ((batch["seq"] as number) < this.warmupBars || k < WARMUP_BARS)
      return [];

    const mom = (n: number): number =>
      k < n ? 0 : close / this.closes[k - n] - 1;

    if (!holding) {
      if (this.cooldown === 0 && mom(20) >= ENTRY_MOM20_MIN) {
        const spend = Math.floor(cash * TRANCHE1_FRACTION);
        if (spend >= MIN_NOTIONAL) {
          this.entryRef = close;
          this.peakClose = close;
          this.stage = 1;
          return [
            {
              side: "buy",
              client_id: this.clientId(),
              symbol: SYMBOL,
              notional_quote_units: String(spend),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
      return [];
    }

    // Holding: exits first (they are rare by design).
    const gain = this.entryRef ? close / this.entryRef - 1 : 0;
    let exitNow = false;
    if (k > EMA_WINDOW && this.ema !== null) {
      if (close < this.ema * (1 - BREAK_DEPTH) && mom(60) < BREAK_MOM60)
        exitNow = true;
    } else if (this.entryRef && close < this.entryRef * (1 - EARLY_STOP)) {
      exitNow = true;
    }
    if (gain > LOCK_GAIN && close < this.peakClose * (1 - LOCK_TRAIL))
      exitNow = true;
    if (exitNow) {
      this.cooldown = COOLDOWN_BARS;
      this.stage = 0;
      return [
        {
          side: "sell",
          client_id: this.clientId(),
          symbol: SYMBOL,
          qty: heldQty as string,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }

    // Second tranche: confirmed dip, or late completion on trend.
    if (this.stage === 1 && this.entryRef) {
      const dipped =
        close <= this.entryRef * (1 - DIP_DEPTH) &&
        close > this.closes[k - 1];
      const late = k > LATE_BARS && mom(60) > 0;
      if (dipped || late) {
        const spend = Math.floor(cash * TRANCHE2_FRACTION);
        if (spend >= MIN_NOTIONAL) {
          this.stage = 2;
          return [
            {
              side: "buy",
              client_id: this.clientId(),
              symbol: SYMBOL,
              notional_quote_units: String(spend),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
    }
    return [];
  }
}

let bot: Bot | null = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const text = line.trim();
  if (!text) return;
  const msg = JSON.parse(text) as Json;
  if (msg["type"] === "hello") {
    bot = new Bot(msg);
  } else if (msg["type"] === "batch") {
    const orders = bot ? bot.onBatch(msg) : [];
    const reply = { type: "reply", seq: msg["seq"], orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
  } else if (msg["type"] === "done") {
    process.exit(0);
  }
});
