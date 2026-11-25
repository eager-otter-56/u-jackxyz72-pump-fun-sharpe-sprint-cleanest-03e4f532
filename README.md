[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Sharpe Sniper — Hot-Launch Crowd Bot

A paper-trading bot for the Pump.fun Sharpe Sprint: it trades a 6-hour pump.fun forward replay,
ranked by hourly Sharpe ratio, not raw PnL. Steady, controlled gains beat one lucky moonshot.

## Strategy

Most pump.fun launches die within minutes, but the first few slots after creation carry the whole
story. The bot buys **only fresh launches in their first 3 slots** that show a real crowd:

- at least 7 trades, at least 4 distinct non-creator buyers, at least 8 SOL net inflow,
- price already +30% over the creation price, at least 3 SOL of real reserves,
- and the creator has not sold.

It sizes small — 0.25 SOL per coin, capped at 1% of real reserves — and exits fast and
mechanically: 10% take-profit, a 3% trailing stop armed from entry, a 12% stop loss as the
backstop for one-batch cliffs, out on any creator sell, and a hard 6-slot hold cap. Fast exits
keep each coin's return small and smooth, which is what an hourly Sharpe ranking rewards.

Two guardrails keep the entry safe: a 15% equity-drawdown halt stops new entries while the book
is bleeding, and tiny 0.01 SOL probe round trips insure the 20-distinct-coin minimum bar if the
main sniper ever lags. Buys are capped at 5% slippage, so a price jump inside the 2-slot latency
refuses the fill instead of chasing it; exits are sent with wide 50% slippage, because a stop
that is refused in a crash only retries later at a worse price.

Everything is deterministic — exact bigint price ratios, no clock, no randomness — so the two
grading executions agree byte for byte.

## Layout

- `main.ts` — entry point: speaks agent-fun/replay/v2 over stdin/stdout.
- `strategy.ts` — the sniper: crowd books, exits, probes, drawdown guard.
- `vendor/makefun-bot.ts` — the protocol shim (vendored SDK).

## Local grade

Run from the kit directory with the process driver (no Docker needed):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
