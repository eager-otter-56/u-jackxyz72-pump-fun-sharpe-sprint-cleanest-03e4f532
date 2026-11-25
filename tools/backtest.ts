// Offline backtest of strategy.ts on the kit's dev window, loading ALL dataset parts
// (the pilot's loader reads only part-00000) and driving the local engine port in
// tools/sim.ts. The bot never imports this file.
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.4}'] [--trips]
//
// Prints net PnL, fills, coins, drawdown and reject reasons; --trips lists every round trip.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

function loadAllParts(kit: string): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  const parts = ['part-00000', 'part-00001', 'part-00002'];
  let all: any[] = [];
  for (const p of parts) {
    const raw = gunzipSync(readFileSync(`${kit}/dataset/events/${p}.ndjson.gz`)).toString('utf8');
    all = all.concat(raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l)));
  }
  for (const e of all) {
    if (e.event === 'CreateEvent' && !members.has(e.mint)) {
      const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
      if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
        members.add(e.mint);
      }
    }
    if (members.has(e.mint)) events.push(e);
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const lastSlot = all.length > 0 ? all[all.length - 1].slot : 0;
  return { sha256: kitJson.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? lastSlot, batches };
}

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadAllParts(kit);
const hello = makeHello(phaseSeed('u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const r = simulate(ds, hello, createStrategy(params));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${r.trips.filter((t) => t.pnl > 0n).length}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, t.open, t.close - t.open, sol(t.pnl));
}
