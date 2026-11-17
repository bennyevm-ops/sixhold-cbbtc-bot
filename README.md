[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/bennyevm-ops/sixhold-cbbtc-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/bennyevm-ops/sixhold-cbbtc-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# SixHold — cbBTC paper-trading bot

Entry for the make.fun bounty "Race a BTC trading bot live for 24 hours"
(btc-race-24h-20261117-0603). The bot trades Coinbase Wrapped BTC (cbBTC)
minute by minute against USDC with $1,000 of paper money under the
agent-fun/bars-replay/v1 protocol: it reads one JSON line per batch on stdin
and answers with buy/sell orders on stdout.

## Strategy

Fees plus slippage plus price impact cost roughly a third of a percent per
round trip at full size, so SixHold trades as rarely as possible:

- **Tranche 1 (~52% of cash)** as soon as 20-minute momentum is not negative.
- **Tranche 2 (~88% of remaining cash)** on a confirmed dip (≥0.6% under the
  first entry and turning up), or after ~7 hours if 60-minute momentum is
  positive and no dip came.
- **Disaster exit** only on a 1.8% break under the 4-hour EMA with momentum
  confirming (flat −3% stop before the EMA exists).
- **Profit lock** arms above +2.0% and trails 0.75% under the peak close.
- **180-bar cooldown** after any exit, so chop cannot churn the bot.

Deterministic: no clock, no network, no files, no randomness. Node 22,
no dependencies; the bot is `main.ts` in the repository root.

## License

MIT — see LICENSE.
