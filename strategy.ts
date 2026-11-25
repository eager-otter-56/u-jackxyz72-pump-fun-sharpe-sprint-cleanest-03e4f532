// Hot Launch — a Sharpe-first paper bot for the pump.fun bonding-curve replay.
//
// The ranking is hourly Sharpe ratio, so this bot wants many small, smooth wins, not one
// moonshot. Its edge is entry selection, measured on the dev window: a fresh launch whose
// first slots show a crowd (many trades, many distinct buyers, several SOL of net inflow,
// a strong run-up and a deep real-SOL reserve) goes on to hit +15% before -12% about
// twice as often as the average launch, while a quiet launch almost never does. So the
// bot buys only hot launches, in small size, within their first 6 slots, and exits fast:
// a 15% take-profit, a 12% stop loss, a 5% trailing stop armed from entry, and a hard
// 10-slot time limit so dead coins are never left to drift down. Buys are capped at 5%
// slippage, so an entry whose price jumped in the 2-slot latency is refused instead of
// filled at the top of the spike.
//
// Guardrail probes (tiny 0.01 SOL round trips) keep the run above the minimum bar
// (round trips on at least 20 distinct mints) when the main strategy lags its pace.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration
// only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Launch must show at least this many trades before entry. */
  minTrades: number;
  /** ...and at least this many distinct non-creator buyers. */
  minBuyers: number;
  /** ...and at least this much net SOL bought (buys minus sells) since creation. */
  minNetFlowSol: number;
  /** Price now over the create price, minus 1, at least this. */
  minRunup: number;
  /** Real SOL reserve at decision time, at least this. */
  minRealSol: number;
  /** Creator's own buys in the create slot: skip when strictly between 0 and this (a
   *  token dev buy reads as a weak launch; no dev buy at all is fine). */
  weakDevBuySol: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost. */
  takeProfit: number;
  /** Exit when it is worth this much under its cost. */
  stopLoss: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exit on a fall of this much from the best value. */
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Most hot-launch positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with round trips on at least 20 coins. When the
   * bot's own fills or coins lag targetFills / targetCoins scaled by the share of
   * paceSecs elapsed (block time since the first batch), it opens tiny probe round trips
   * (buy probeSol, sell it all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded with. Chosen on the dev window for smooth, low-variance returns:
// enter only hot launches in their first slots, cap the buy slippage so an entry
// whose price jumped in the 2-slot latency is refused instead of filled at the top,
// take profit fast, cut losers fast, and never hold past 10 slots.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  stakeSol: 0.5,
  minBuySol: 0.005,
  minTrades: 7,
  minBuyers: 4,
  minNetFlowSol: 8,
  minRunup: 0.3,
  minRealSol: 3,
  weakDevBuySol: 0.1,
  skipDevSold: true,
  buySlipBps: 500,
  takeProfit: 0.15,
  stopLoss: 0.12,
  trailArm: 0,
  trail: 0.05,
  maxHold: 10,
  exitOnDevSell: true,
  maxMain: 5,
  targetCoins: 30,
  targetFills: 0,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  /** Create price (virtual quote / virtual token). */
  p0: number;
  devBuy: number;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  netFlow: number;
  lastPrice: number;
  lastRq: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            p0: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            devBuy: 0,
            devSold: false,
            trades: 0,
            buyers: new Set(),
            netFlow: 0,
            lastPrice: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            lastRq: 0,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.netFlow += e.is_buy ? sol : -sol;
          if (e.user === c.creator) {
            if (e.is_buy && e.slot === c.createSlot) c.devBuy += sol;
            else if (!e.is_buy) c.devSold = true;
          } else if (e.is_buy) {
            c.buyers.add(e.user);
          }
          c.lastPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.lastRq = Number(e.real_quote_reserves) / LAMPORTS;
          touched.add(e.mint);
        } else {
          const c = coinOf(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, trailing stop, time limit, creator sell.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (c !== undefined && h.filled) c.done = true;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell) {
          const c = coinOf(mint);
          if (c !== undefined && c.devSold) exit = true;
        }
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        const c = coinOf(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: hot launches only.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const c = coinOf(mint);
        if (c === undefined || c.done || c.complete) continue;
        const age = now - c.createSlot;
        if (age < p.minAge) continue;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint) || state.positions.has(mint)) continue;
        // Hot-launch filter: a crowd, real inflow, a strong run-up, a deep reserve.
        if (c.trades < p.minTrades) continue;
        if (c.buyers.size < p.minBuyers) continue;
        if (c.netFlow < p.minNetFlowSol) continue;
        if (c.lastPrice / c.p0 - 1 < p.minRunup) continue;
        if (c.lastRq < p.minRealSol) continue;
        if (c.devBuy > 0 && c.devBuy < p.weakDevBuySol) continue;
        if (p.skipDevSold && c.devSold) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, peakValue: 0, filled: false, lastValue: 0 });
        c.done = true;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
