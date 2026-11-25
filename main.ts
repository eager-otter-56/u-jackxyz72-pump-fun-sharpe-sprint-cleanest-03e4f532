// main.ts — Pump.fun Sharpe Sprint: cleanest paper bot wins.
//
// Entrypoint, run by the grader as `node /bot/main.ts`. It hands the hot-launch sniper
// strategy (strategy.ts) to the replay harness shim (vendor/makefun-bot.ts): the shim owns
// the wire — one `hello`, then one `batch` per slot, then `done` — and this file owns
// nothing but the wiring, so the strategy stays testable on its own.
//
// The bot trades paper SOL on a 6-hour pump.fun forward replay. It buys only fresh
// launches in their first three slots that already show a crowd (trades, distinct buyers,
// net inflow, price up 30% on creation), sizes 0.25 SOL capped at 1% of real reserves,
// and exits on take-profit, trailing stop, stop loss, creator sell, or a six-slot hold
// cap. A drawdown halt and 0.01 SOL probe round trips guard the minimum bar. Ranking is
// by hourly Sharpe ratio, so the design prefers smooth, low-variance returns.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state) => {
    // Diagnostics go to stderr: stdout carries harness replies only.
    console.error(
      `done: cash=${state.cash} lamports, positions=${state.positions.size}, batches=${state.seq + 1}`,
    );
  },
});
