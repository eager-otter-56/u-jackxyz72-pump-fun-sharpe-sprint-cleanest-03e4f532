// strategy.ts
// Hot-launch sniper for the Pump.fun Sharpe Sprint (pumpfun-replay/v2).
//
// The idea, in one paragraph: a fresh pump.fun launch either catches a crowd in its first
// minutes or fades. This bot only buys a launch inside its first three slots, and only when
// the crowd is already visible on chain — at least seven trades, at least four distinct
// buyers who are not the creator, at least 8 SOL of net inflow, the price already 30% above
// its creation price, and at least 3 SOL sitting in real reserves. It buys small (0.25 SOL,
// capped at the harness's 1% of real reserves), then exits fast and mechanically: a 10%
// take-profit, a 3% trailing stop that trails the peak once the price has risen above the
// entry, a 12% stop loss as a cliff backstop for gap-downs between slots, an exit the moment
// the creator sells, and a hard six-slot hold cap. A 15% equity-drawdown halt stops new
// entries while the book is bleeding, and 0.01 SOL probe round trips bank the
// 20-distinct-coin minimum bar when the main filter finds little. Every price comparison
// is an exact bigint ratio — no floats, no clock, no randomness — so the two grading
// executions produce byte-identical action logs.
//
// Ranking is by hourly Sharpe ratio, not raw PnL, so the design prefers smooth,
// lower-variance returns: small stakes, quick exits, many coins, no moonshot chasing.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// --- tuned parameters -------------------------------------------------------
const STAKE_LAMPORTS = SOL / 4n; // 0.25 SOL per snipe
const PROBE_LAMPORTS = SOL / 100n; // 0.01 SOL probe round trip
const BUY_SLIPPAGE_BPS = 500; // buys refuse worse than 5% slippage
const SELL_SLIPPAGE_BPS = 5000; // exits accept up to 50% slippage
const ENTRY_WINDOW_SLOTS = 3; // buys only in a launch's first 3 slots
const MIN_TRADES = 7; // crowd: trades seen since creation
const MIN_BUYERS = 4; // crowd: distinct non-creator buyers
const MIN_NET_INFLOW = 8n * SOL; // crowd: buys minus sells, in SOL
const MIN_REAL_RESERVES = 3n * SOL; // curve must hold real SOL
const MIN_GAIN_BPS = 3000; // price already +30% vs creation
const TAKE_PROFIT_BPS = 1000; // exit at +10%
const TRAILING_BPS = 300; // exit 3% below the peak once in profit
const STOP_LOSS_BPS = 1200; // exit at -12%, the cliff backstop
const MAX_HOLD_SLOTS = 6; // hard hold cap, in slots
const DRAWDOWN_HALT_BPS = 1500; // halt new entries at -15% equity
const MIN_DISTINCT_COINS = 20; // guardrail: round trips on 20 coins
const PROBE_MIN_TRADES = 3; // probes need only a faint pulse
const PROBE_MIN_REAL_RESERVES = SOL; // probes need 1 SOL of real reserves
const PROBE_MAX_AGE_SLOTS = 10; // probes only on young coins
const MAX_PROBES_PER_BATCH = 2; // probes are filler, never the book

// --- exact price math -------------------------------------------------------
// A price is a ratio quote/tokens. These compare ratios by cross-multiplication, so no
// float ever touches a decision.

/** priceA >= priceB grown by bps (priceB * (10000 + bps) / 10000). */
function priceAtLeast(
  aQuote: bigint,
  aTokens: bigint,
  bQuote: bigint,
  bTokens: bigint,
  bps: number,
): boolean {
  if (aTokens <= 0n || bTokens <= 0n) return false;
  return aQuote * bTokens * 10_000n >= bQuote * aTokens * BigInt(10_000 + bps);
}

/** priceA <= priceB shrunk by bps (priceB * (10000 - bps) / 10000). */
function priceAtMost(
  aQuote: bigint,
  aTokens: bigint,
  bQuote: bigint,
  bTokens: bigint,
  bps: number,
): boolean {
  if (aTokens <= 0n || bTokens <= 0n) return false;
  return aQuote * bTokens * 10_000n <= bQuote * aTokens * BigInt(10_000 - bps);
}

/** priceA > priceB, strictly. */
function priceAbove(aQuote: bigint, aTokens: bigint, bQuote: bigint, bTokens: bigint): boolean {
  if (aTokens <= 0n || bTokens <= 0n) return false;
  return aQuote * bTokens > bQuote * aTokens;
}

// --- per-coin and per-position records --------------------------------------

/** Everything the bot remembers about one launch it saw created. */
interface Coin {
  mint: string;
  creator: string;
  createdSlot: number;
  /** Virtual reserves at creation: the reference price. */
  createQuote: bigint;
  createTokens: bigint;
  /** Distinct non-creator buyers, from TradeEvents. */
  buyers: Set<string>;
  /** Buy SOL minus sell SOL since creation. */
  netInflow: bigint;
  creatorSold: boolean;
  /** Bought, or permanently passed over (window closed, filter failed, buy rejected). */
  decided: boolean;
  /** This coin was bought as a guardrail probe, not a snipe. */
  probe: boolean;
  complete: boolean;
}

/** An open position, with the entry fill and the peak price since entry. */
interface Held {
  mint: string;
  /** SOL spent on the entry fill, fees included. */
  entryQuote: bigint;
  /** Tokens received on the entry fill. */
  entryTokens: bigint;
  /** Slot the entry fill resolved at. */
  entrySlot: number;
  /** Highest price seen since entry, as a ratio. */
  peakQuote: bigint;
  peakTokens: bigint;
  probe: boolean;
}

/** Build the sniper. One strategy object per run; all of its memory lives in closures. */
export function createStrategy(): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<string, Coin>();
  const held = new Map<string, Held>();
  /** Mints whose buy leg was at least 0.01 SOL (the round-trip bar counts those). */
  const boughtBig = new Set<string>();
  /** Mints with a completed round trip of at least 0.01 SOL. */
  const roundTripped = new Set<string>();
  let peakEquity = 0n;
  let peakSet = false;

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    // --- 1. Ingest this slot's events into the per-coin records. ---------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            creator: e.creator,
            createdSlot: e.slot,
            createQuote: BigInt(e.virtual_quote_reserves),
            createTokens: BigInt(e.virtual_token_reserves),
            buyers: new Set<string>(),
            netInflow: 0n,
            creatorSold: false,
            decided: false,
            probe: false,
            complete: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const coin = coins.get(e.mint);
        if (coin === undefined) continue; // creation unseen: no reference price, skip
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          coin.netInflow += sol;
          if (e.user !== coin.creator) coin.buyers.add(e.user);
        } else {
          coin.netInflow -= sol;
          if (e.user === coin.creator) coin.creatorSold = true;
        }
      } else {
        const coin = coins.get(e.mint);
        if (coin !== undefined) coin.complete = true;
      }
    }

    // --- 2. Ingest fills: entries seed Held records, exits close round trips. ---
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        const coin = coins.get(f.mint);
        if (f.status === 'filled') {
          const quote = BigInt(f.quote_lamports);
          const tokens = BigInt(f.token_amount);
          if (tokens > 0n) {
            held.set(f.mint, {
              mint: f.mint,
              entryQuote: quote,
              entryTokens: tokens,
              entrySlot: f.slot,
              peakQuote: quote,
              peakTokens: tokens,
              probe: coin?.probe ?? false,
            });
            if (quote >= PROBE_LAMPORTS || coin?.probe === true) boughtBig.add(f.mint);
          }
        } else {
          // Rejected or failed: the coin stays decided (one shot), but a probe that
          // never filled must not count as a live probe below.
          if (coin !== undefined) coin.probe = false;
        }
      } else if (f.side === 'sell' && f.status === 'filled') {
        held.delete(f.mint);
        if (boughtBig.has(f.mint)) roundTripped.add(f.mint);
      }
    }

    // --- 3. Reconcile Held records with the account; track each peak price. -----
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      let h = held.get(mint);
      if (h === undefined) {
        // Defensive: a position with no fill seen (never happens in practice, since
        // fills precede the account in the same batch). Seed from cost and now.
        h = {
          mint,
          entryQuote: pos.cost_lamports,
          entryTokens: pos.token_amount,
          entrySlot: batch.slot,
          peakQuote: curve.virtual_quote_reserves,
          peakTokens: curve.virtual_token_reserves,
          probe: false,
        };
        held.set(mint, h);
      }
      if (curve.virtual_token_reserves > 0n && curve.virtual_quote_reserves > 0n) {
        if (
          curve.virtual_quote_reserves * h.peakTokens >
          h.peakQuote * curve.virtual_token_reserves
        ) {
          h.peakQuote = curve.virtual_quote_reserves;
          h.peakTokens = curve.virtual_token_reserves;
        }
      }
    }

    // --- 4. Equity and the drawdown halt. ---------------------------------------
    let equity = state.cash;
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.virtual_token_reserves > 0n) {
        equity += (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      }
    }
    if (!peakSet) {
      peakEquity = BigInt(state.hello.capital.lamports);
      peakSet = true;
    }
    if (equity > peakEquity) peakEquity = equity;
    const halted =
      peakEquity > 0n && equity * 10_000n <= peakEquity * BigInt(10_000 - DRAWDOWN_HALT_BPS);

    // --- 5. Decide this batch's orders. Exits first, then buys, then probes. ----
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }

    // Exits: creator sell, hold cap, take-profit, stop loss, trailing stop, probe.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // harness closes completes
      const h = held.get(mint);
      if (h === undefined) continue;
      const curQ = curve.virtual_quote_reserves;
      const curT = curve.virtual_token_reserves;
      if (curQ <= 0n || curT <= 0n) continue;
      const age = batch.slot - h.entrySlot;
      const coin = coins.get(mint);
      let exit = false;
      if (coin?.creatorSold === true) exit = true;
      else if (age >= MAX_HOLD_SLOTS) exit = true;
      else if (priceAtLeast(curQ, curT, h.entryQuote, h.entryTokens, TAKE_PROFIT_BPS)) exit = true;
      else if (priceAtMost(curQ, curT, h.entryQuote, h.entryTokens, STOP_LOSS_BPS)) exit = true;
      else if (
        priceAbove(h.peakQuote, h.peakTokens, h.entryQuote, h.entryTokens) &&
        priceAtMost(curQ, curT, h.peakQuote, h.peakTokens, TRAILING_BPS)
      ) {
        exit = true;
      } else if (h.probe && age >= 1) exit = true;
      if (!exit) continue;
      if (free < txFee) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      };
      orders.push(sell);
      free -= txFee;
    }

    // Snipe buys: fresh launches, in their first three slots, with a visible crowd.
    let buysPlaced = 0;
    if (!halted) {
      for (const coin of coins.values()) {
        if (orders.length >= maxOrders) break;
        if (coin.decided || coin.complete) continue;
        if (batch.slot - coin.createdSlot >= ENTRY_WINDOW_SLOTS) {
          coin.decided = true;
          continue;
        }
        if (state.positions.has(coin.mint) || pendingBuy.has(coin.mint)) continue;
        const curve = state.curves.get(coin.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.trades < MIN_TRADES) continue;
        if (coin.buyers.size < MIN_BUYERS) continue;
        if (coin.netInflow < MIN_NET_INFLOW) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVES) continue;
        if (coin.creatorSold) continue;
        if (coin.createTokens <= 0n || curve.virtual_token_reserves <= 0n) continue;
        if (
          !priceAtLeast(
            curve.virtual_quote_reserves,
            curve.virtual_token_reserves,
            coin.createQuote,
            coin.createTokens,
            MIN_GAIN_BPS,
          )
        ) {
          continue;
        }
        const cap = state.maxBuyLamports(coin.mint);
        const size = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
        if (size < PROBE_LAMPORTS) continue;
        if (openSlots - buysPlaced <= 0) continue;
        if (free < size + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint: coin.mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        orders.push(buy);
        coin.decided = true;
        buysPlaced += 1;
        free -= size + txFee;
      }
    }

    // Probes: only when the 20-coin bar is short, only as filler (no snipe fired),
    // only on young coins that have not collapsed below their creation price.
    if (!halted && buysPlaced === 0 && roundTripped.size < MIN_DISTINCT_COINS) {
      let probesLive = 0;
      for (const c of coins.values()) {
        if (!c.probe || roundTripped.has(c.mint)) continue;
        if (held.has(c.mint) || pendingBuy.has(c.mint)) probesLive += 1;
      }
      if (roundTripped.size + probesLive < MIN_DISTINCT_COINS) {
        let probesPlaced = 0;
        for (const coin of coins.values()) {
          if (orders.length >= maxOrders) break;
          if (probesPlaced >= MAX_PROBES_PER_BATCH) break;
          if (coin.decided || coin.complete) continue;
          if (batch.slot - coin.createdSlot > PROBE_MAX_AGE_SLOTS) continue;
          if (state.positions.has(coin.mint) || pendingBuy.has(coin.mint)) continue;
          const curve = state.curves.get(coin.mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.trades < PROBE_MIN_TRADES) continue;
          if (coin.creatorSold) continue;
          if (curve.real_quote_reserves < PROBE_MIN_REAL_RESERVES) continue;
          if (coin.createTokens <= 0n || curve.virtual_token_reserves <= 0n) continue;
          if (
            curve.virtual_quote_reserves * coin.createTokens <
            coin.createQuote * curve.virtual_token_reserves
          ) {
            continue;
          }
          const cap = state.maxBuyLamports(coin.mint);
          if (cap < PROBE_LAMPORTS) continue;
          if (openSlots - buysPlaced <= 0) continue;
          if (free < PROBE_LAMPORTS + txFee) continue;
          const buy: BuyInput = {
            side: 'buy',
            mint: coin.mint,
            quote_lamports: PROBE_LAMPORTS,
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          };
          orders.push(buy);
          coin.decided = true;
          coin.probe = true;
          buysPlaced += 1;
          probesPlaced += 1;
          free -= PROBE_LAMPORTS + txFee;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
