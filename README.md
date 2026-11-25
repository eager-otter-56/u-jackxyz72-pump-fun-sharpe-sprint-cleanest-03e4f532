[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Snipe — Pump.fun Sharpe Sprint

A Sharpe-first paper-trading bot for a 6-hour pump.fun forward replay. The ranking
is hourly Sharpe ratio, not raw PnL, so this bot chases many small, low-variance wins
instead of one moonshot.

## Strategy

- **Entry:** only hot launches, bought within their first 6 slots: at least 7 trades
  from at least 4 distinct non-creator buyers, at least 8 SOL of net inflow since
  creation, price up 30%+ from the create price, at least 3 SOL of real reserves,
  and the creator must not have sold (a token dev buy under 0.1 SOL also disqualifies).
- **Sizing:** up to 0.5 SOL per coin, capped at 1% of the coin's real SOL reserves
  per reply; at most 5 open positions and 4 SOL of total exposure.
- **Slippage guard:** buys are capped at 5% slippage, so an entry whose price jumped
  in the 2-slot latency is refused instead of filled at the top of the spike.
- **Exits:** 15% take-profit, 12% stop loss, a 5% trailing stop armed from entry,
  exit when the creator sells, and a hard 10-slot time limit.
- **Guardrails:** tiny 0.01 SOL probe round trips keep the run above the minimum bar
  (round trips on at least 20 distinct mints) when the main strategy lags its pace.

Local dev grade (kit grader, process driver): net **+0.094 SOL**, 192 coins,
win rate 33.9%, max drawdown 3.6%, guardrails met, deterministic (L1 regrade
reproduced byte for byte).

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`).
- `strategy.ts` — the strategy, written fresh for this competition.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/` — local backtest harness (dev only; the bot never imports it).

## Local grade

Run the kit's grader against this repository (process driver, no Docker needed):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
