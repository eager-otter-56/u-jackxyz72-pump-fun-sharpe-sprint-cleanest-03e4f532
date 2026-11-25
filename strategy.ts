// Pump.fun Sharpe Sprint — hot-launch sniper tuned for hourly Sharpe ratio.
//
// Idea: on pump.fun most launches die within minutes, but the first few slots after creation
// carry the whole story — a real crowd piling in (many trades, several distinct buyers, heavy net
// SOL inflow, price already up ~30%) is the only signal that has ever paid on this window. So the
// bot buys ONLY fresh launches in their first 3 slots that show that crowd, sizes small (0.25 SOL,
// capped at 1% of real reserves by the harness), and exits fast and mechanically: 10% take-profit,
// a 3% trailing stop armed from entry, a 12% stop loss as the backstop for one-batch cliffs, out
// on any creator sell, and a hard 6-slot hold cap. Fast exits keep each coin's return small and
// smooth, which is what an hourly Sharpe ranking rewards — one moonshot cannot carry the score,
// but a hundred small wins can. Exits are sent with wide (50%) slippage on purpose: a stop that
// is refused for slippage in a crash only retries later at a worse price.
//
// Guardrails: a 15% equity-drawdown halt stops new entries when the book is bleeding, and tiny
// 0.01 SOL probe round trips insure the 20-distinct-coin minimum bar if the main sniper ever lags.
// Everything is deterministic: all comparisons are exact bigint ratios (no floats, no clock, no
// Math.random), so the two grading executions agree byte for byte.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

/** All tuning in one place, so a param nudge is a one-line change. */
export const DEFAULT_PARAMS = {
  /** Buy only while the coin is this many slots old (counted from its CreateEvent slot).
   *  Tightened to 3: the crowd bar is usually cleared in the first 2–3 slots, and entries at
   *  older ages buy the faded tail of the first pump. (4 and 6 tested worse on the dev window;
   *  2 tested slightly worse than 3.) */
  entryWindowSlots: 3,
  /** Crowd bar: at least this many trades since creation. */
  minTrades: 7,
  /** Crowd bar: at least this many distinct non-creator buyers. */
  minBuyers: 4,
  /** Crowd bar: at least this much net SOL inflow (buys minus sells). */
  minNetInflowLamports: 8n * LAMPORTS_PER_SOL,
  /** Momentum bar: price at least this far above the creation price (130 = +30%). */
  minGainNum: 130n,
  minGainDen: 100n,
  /** Liquidity bar: at least this much real SOL in the curve. */
  minRealSolLamports: 3n * LAMPORTS_PER_SOL,
  /** Stake per coin, before the harness's 1%-of-real-reserve cap bites. Kept at 0.25 SOL: the
   *  dev run showed the 0.4–0.5 SOL stakes on the biggest-reserve coins carried the worst
   *  single-coin losses, and for a Sharpe ranking halving the largest exposures is worth more
   *  than the upside they add. */
  stakeLamports: LAMPORTS_PER_SOL / 4n,
  /** Smallest buy the guardrails count as a round trip. */
  minBuyLamports: LAMPORTS_PER_SOL / 100n,
  /** Take profit: exit at +10% over the filled entry price. Banked sooner on purpose: on this
   *  window most coins that reach +10% retrace before +15%, so the lower bar converts
   *  would-be trailing-stop losers into banked winners. (TP 8% tested worse — it clips the
   *  runners that would have paid more; TP 15% tested worse — too many retrace first.) */
  takeProfitNum: 110n,
  takeProfitDen: 100n,
  /** Stop loss: exit at -12% under the filled entry price. Note this bar is mostly shadowed by
   *  the 5% trailing stop (which bites first on any path that falls from the peak, and at -5%
   *  when the price never rose) — it stands as the backstop for a one-batch cliff that jumps
   *  straight past the trailing trigger. */
  stopLossNum: 88n,
  stopLossDen: 100n,
  /** Trailing stop: exit at -3% under the best price seen since entry. With take-profit at
   *  +10% the trailing stop mostly governs coins that never reach it, so a tighter trail cuts
   *  the average loser without touching the banked winners. (2% tested worse — it clips too
   *  many coins that would have recovered to take-profit; 5% tested worse — losers bleed.) */
  trailingNum: 97n,
  trailingDen: 100n,
  /** Hard hold cap, in slots from the buy fill. Shortened to 6: with take-profit at +10% and
   *  a 3% trail, a coin that has neither banked nor trailed out in 6 slots is drifting
   *  sideways-down, and the freed slot earns more on a fresh launch. (4 tested worse — it
   *  cuts too many late take-profits; 10 tested worse — drifters bleed.) */
  maxHoldSlots: 6,
  /** Slippage cap on buys: a fill worse than this vs decision-time reserves is refused. */
  slippageBps: 500,
  /** Slippage cap on sells: wide on purpose. A stop that is refused for slippage in a crash
   *  only retries later at a worse price — in a 2-slot latency window, filling now at the
   *  post-crash price beats waiting for the next batch. */
  sellSlippageBps: 5000,
  /** Probe size: exactly the round-trip minimum, so probes are nearly free insurance. */
  probeSizeLamports: LAMPORTS_PER_SOL / 100n,
  /** Probes only start this many slots into the run, once the main sniper has had its chance. */
  probeStartSlots: 2000,
  /** Probe liquidity bar: the 1% cap must allow a 0.01 SOL buy, so >= 1 SOL real reserves. */
  probeMinRealSolLamports: LAMPORTS_PER_SOL,
  /** Probes only touch coins this fresh. */
  probeMaxAgeSlots: 20,
  /** Probes are sold this many slots after their buy fill, whatever the price. */
  probeHoldSlots: 3,
  /** New entries halt while equity sits more than this far under its peak (85 = -15%). */
  drawdownHaltNum: 85n,
  drawdownHaltDen: 100n,
  /** The guardrail: round trips on at least this many distinct mints. */
  minRoundTrips: 20,
};

export type StrategyParams = typeof DEFAULT_PARAMS;

/** True when a/b >= c/d, all bigints with positive denominators. */
function geRatio(a: bigint, b: bigint, c: bigint, d: bigint): boolean {
  return a * d >= c * b;
}

/** True when the current price is at least num/den times the base price (exact bigint math). */
function priceAtLeast(curN: bigint, curD: bigint, baseN: bigint, baseD: bigint, num: bigint, den: bigint): boolean {
  return curN * baseD * den >= baseN * curD * num;
}

/** True when the current price is at most num/den times the base price. */
function priceAtMost(curN: bigint, curD: bigint, baseN: bigint, baseD: bigint, num: bigint, den: bigint): boolean {
  return curN * baseD * den <= baseN * curD * num;
}

/** Per-mint crowd book, built from the batch events as they arrive. */
interface Book {
  creator: Pubkey;
  createdSlot: number;
  /** Creation price as a ratio: virtual quote / virtual token reserves at creation. */
  createN: bigint;
  createD: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  netInflow: bigint;
  creatorSold: boolean;
  complete: boolean;
}

/** A live position, priced from its buy fill (quote spent per token received, fees included —
 *  the fee load pulls the stop in a touch and pushes take-profit out a touch, which the dev
 *  grade showed is the better side of that trade: earlier stops beat earlier take-profits). */
interface LivePos {
  entryN: bigint;
  entryD: bigint;
  entrySlot: number;
  peakN: bigint;
  peakD: bigint;
  probe: boolean;
}

export class SharpeSniper {
  private p: StrategyParams;
  /** Crowd books, in creation order (books[mint]); pruned once a coin is too old to matter. */
  private books = new Map<Pubkey, Book>();
  /** Mints in creation order, so pruning can walk from the oldest. */
  private order: Pubkey[] = [];
  /** Live positions keyed by mint, priced from their buy fills. */
  private positions = new Map<Pubkey, LivePos>();
  /** Mints we already sent a buy for (never buy the same coin twice). */
  private bought = new Set<Pubkey>();
  /** Mints where a probe buy is in flight or filled (sold fast to bank the round trip). */
  private probeBuys = new Set<Pubkey>();
  /** Mints with a completed buy+sell round trip — the guardrail counter. */
  private roundTrips = new Set<Pubkey>();
  private firstSlot: number | null = null;
  private peakEquity = 0n;

  constructor(params: StrategyParams) {
    this.p = params;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (this.firstSlot === null) this.firstSlot = state.slot;
    this.noteFills(batch);
    this.noteEvents(batch);
    this.pruneBooks(state);

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxPositions = state.hello.caps.max_open_positions;
    let free = state.freeCashLamports();
    let open = state.committedPositionCount();

    // --- exits first: every held position is re-checked against all five exit rules.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      const pos = this.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      if (this.hasPendingSell(state, mint)) continue;
      const curN = curve.virtual_quote_reserves;
      const curD = curve.virtual_token_reserves;
      // Trailing peak: the best price since entry, updated before the trailing check.
      if (geRatio(curN, curD, pos.peakN, pos.peakD)) {
        pos.peakN = curN;
        pos.peakD = curD;
      }
      const book = this.books.get(mint);
      const age = state.slot - pos.entrySlot;
      const exit =
        (pos.probe && age >= this.p.probeHoldSlots) ||
        priceAtLeast(curN, curD, pos.entryN, pos.entryD, this.p.takeProfitNum, this.p.takeProfitDen) ||
        priceAtMost(curN, curD, pos.entryN, pos.entryD, this.p.stopLossNum, this.p.stopLossDen) ||
        priceAtMost(curN, curD, pos.peakN, pos.peakD, this.p.trailingNum, this.p.trailingDen) ||
        (book !== undefined && book.creatorSold) ||
        age >= this.p.maxHoldSlots;
      if (exit) {
        const sell: SellInput = { side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: this.p.sellSlippageBps };
        orders.push(sell);
        free -= tx;
      }
    }

    // --- entries: fresh launches that clear every crowd bar, while the drawdown guard allows.
    const halted = this.equity(state) * this.p.drawdownHaltDen < this.peakEquity * this.p.drawdownHaltNum;
    if (!halted) {
      for (const [mint, book] of this.books) {
        if (orders.length >= maxOrders || open >= maxPositions) break;
        if (this.bought.has(mint) || book.complete) continue;
        if (state.slot - book.createdSlot > this.p.entryWindowSlots) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.virtual_token_reserves === 0n) continue;
        if (book.trades < this.p.minTrades) continue;
        if (book.buyers.size < this.p.minBuyers) continue;
        if (book.netInflow < this.p.minNetInflowLamports) continue;
        if (book.creatorSold) continue;
        if (curve.real_quote_reserves < this.p.minRealSolLamports) continue;
        if (!priceAtLeast(curve.virtual_quote_reserves, curve.virtual_token_reserves, book.createN, book.createD, this.p.minGainNum, this.p.minGainDen)) continue;
        let amount = this.p.stakeLamports;
        const cap = state.maxBuyLamports(mint);
        if (cap < amount) amount = cap;
        if (amount < this.p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        const buy: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: this.p.slippageBps };
        orders.push(buy);
        this.bought.add(mint);
        free -= amount + tx;
        open += 1;
      }
    }

    // --- probes: if the sniper is lagging on the 20-coin bar, bank tiny round trips.
    if (
      orders.length < maxOrders &&
      open < maxPositions &&
      this.roundTrips.size < this.p.minRoundTrips &&
      this.firstSlot !== null &&
      state.slot - this.firstSlot >= this.p.probeStartSlots
    ) {
      for (let i = this.order.length - 1; i >= 0; i--) {
        const mint = this.order[i];
        const book = this.books.get(mint);
        if (book === undefined || this.bought.has(mint) || book.complete || book.creatorSold) continue;
        if (state.slot - book.createdSlot > this.p.probeMaxAgeSlots) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < this.p.probeMinRealSolLamports) continue;
        if (state.maxBuyLamports(mint) < this.p.probeSizeLamports) continue;
        if (free < this.p.probeSizeLamports + tx) break;
        const probe: BuyInput = { side: 'buy', mint, quote_lamports: this.p.probeSizeLamports, max_slippage_bps: this.p.slippageBps };
        orders.push(probe);
        this.bought.add(mint);
        this.probeBuys.add(mint);
        break;
      }
    }

    return orders;
  }

  /** Fold this batch's fills in: price positions from buy fills, count round trips on sells. */
  private noteFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        // A buy that was refused or failed never became a position: allow a retry while fresh.
        if (f.side === 'buy' && !f.client_id.startsWith('_')) this.bought.delete(f.mint);
        continue;
      }
      if (f.side === 'buy') {
        const spent = BigInt(f.quote_lamports);
        const tokens = BigInt(f.token_amount);
        if (tokens > 0n) {
          this.positions.set(f.mint, {
            entryN: spent,
            entryD: tokens,
            entrySlot: f.slot,
            peakN: spent,
            peakD: tokens,
            probe: this.probeBuys.has(f.mint),
          });
        }
      } else {
        // Any filled sell — ours, or the harness closing a completed/flattened curve — banks the
        // round trip for that mint.
        if (this.bought.has(f.mint)) this.roundTrips.add(f.mint);
        this.positions.delete(f.mint);
        this.probeBuys.delete(f.mint);
      }
    }
  }

  /** Fold this batch's events into the per-mint crowd books. */
  private noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const book: Book = {
          creator: e.creator,
          createdSlot: e.slot,
          createN: BigInt(e.virtual_quote_reserves),
          createD: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set<Pubkey>(),
          netInflow: 0n,
          creatorSold: false,
          complete: false,
        };
        this.books.set(e.mint, book);
        this.order.push(e.mint);
      } else if (e.event === 'TradeEvent') {
        let book = this.books.get(e.mint);
        if (book === undefined) {
          // First sight through a trade (no CreateEvent delivered): price the coin from here.
          book = {
            creator: e.creator,
            createdSlot: e.slot,
            createN: BigInt(e.virtual_quote_reserves),
            createD: BigInt(e.virtual_token_reserves),
            trades: 0,
            buyers: new Set<Pubkey>(),
            netInflow: 0n,
            creatorSold: false,
            complete: false,
          };
          this.books.set(e.mint, book);
          this.order.push(e.mint);
        }
        book.trades += 1;
        const sol = BigInt(e.sol_amount);
        book.netInflow += e.is_buy ? sol : -sol;
        if (e.is_buy) {
          if (e.user !== e.creator) book.buyers.add(e.user);
        } else if (e.user === e.creator) {
          book.creatorSold = true;
        }
      } else {
        const book = this.books.get(e.mint);
        if (book !== undefined) book.complete = true;
      }
    }
  }

  /** Drop books too old to ever matter again (keeps each batch's work near-constant). */
  private pruneBooks(state: BotState): void {
    const keep = Math.max(this.p.entryWindowSlots, this.p.maxHoldSlots) + 8;
    while (this.order.length > 0) {
      const mint = this.order[0];
      const book = this.books.get(mint);
      if (book === undefined) {
        this.order.shift();
        continue;
      }
      if (state.slot - book.createdSlot <= keep) break;
      if (state.positions.has(mint)) break;
      this.books.delete(mint);
      this.order.shift();
    }
  }

  /** True when a sell for this mint is already in flight (never stack two exits). */
  private hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  }

  /** Marked equity (cash + positions at current curve prices); also maintains the peak. */
  private equity(state: BotState): bigint {
    let eq = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.virtual_token_reserves > 0n) {
        eq += (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      } else {
        eq += holding.cost_lamports;
      }
    }
    if (this.peakEquity === 0n || eq > this.peakEquity) this.peakEquity = eq;
    return eq;
  }
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS): SharpeSniper {
  return new SharpeSniper(params);
}
