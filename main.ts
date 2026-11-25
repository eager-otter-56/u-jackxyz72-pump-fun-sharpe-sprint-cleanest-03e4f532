// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
// Entry point: the harness runs `node /bot/main.ts` and speaks agent-fun/replay/v2 over stdin /
// stdout. Each batch carries one slot of pump.fun events; the strategy answers with the orders
// for that slot (a hello opens the run, then one reply per batch, then done). The strategy lives
// in strategy.ts; the wire protocol in vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
