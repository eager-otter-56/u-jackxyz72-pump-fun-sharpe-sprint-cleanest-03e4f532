[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/eager-otter-56/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Hot-Launch Sniper

A paper-trading bot for a 6-hour pump.fun forward replay, ranked by **hourly Sharpe
ratio** — steady, controlled gains beat one lucky moonshot.

## Strategy

Fresh launches either catch a crowd in their first minutes or fade. This bot buys
only a launch inside its **first 3 slots** that already shows a crowd on chain:

- at least **7 trades**, at least **4 distinct non-creator buyers**,
- at least **8 SOL of net inflow** (buys minus sells),
- price already **+30% vs its creation price**,
- at least **3 SOL of real reserves**, and the creator hasn't sold.

It buys **0.25 SOL**, capped at the harness's 1% of real reserves, at 5% max slippage,
then exits fast and mechanically:

- **+10% take-profit**, **3% trailing stop** once the price has risen above entry,
- **−12% stop loss** as a cliff backstop,
- out the moment the **creator sells**, and a hard **6-slot hold cap**.

Guardrails: a **15% equity-drawdown halt** stops new entries while the book bleeds,
and **0.01 SOL probe round trips** bank the 20-distinct-coin minimum bar when the
main filter finds little. All price math is exact bigint ratios — no floats, no
clock, no randomness — so the two grading executions produce byte-identical logs.

## Files

- `main.ts` — entrypoint: wires the strategy into the replay harness.
- `strategy.ts` — the sniper: crowd filter, exits, drawdown halt, probes.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, byte-identical.

## Run

Graded by the house template `pumpfun-replay` on Node 22: `node main.ts`.

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532
