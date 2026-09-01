import { inferLocationTokens, Memory } from '../src/memory.js';
import { normalizePayee, stripLocations, similarity } from '../src/normalize.js';

const fail = [];

// --- province codes ---------------------------------------------------------
const provinces = [
  ['AVIVA GENERAL INSURANCE C MARKHAM, ON', 'aviva general insurance'],
  ['ENERCARE HOME SERVICES MARKHAM, ON', 'enercare home services'],
  // A two-token result keeps the city — normalizePayee will not strip a key
  // down to one token on its own. The corpus-level inference below is what
  // removes it, which is why both mechanisms exist.
  ['LULULEMON 123 VANCOUVER, BC', 'lululemon vancouver'],
];
for (const [input, expected] of provinces) {
  const got = normalizePayee(input);
  if (got !== expected) fail.push(`normalizePayee(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
}

// --- inferring locations from a corpus --------------------------------------
// "toronto" spans many merchants; "woofgang" belongs to one.
const keys = [
  'nodo leslieville toronto', 'alter leslieville toronto', 'lambos leslieville toronto',
  'timmie leslieville toronto', 'winners toronto', 'ikea toronto', 'farm boy toronto',
  'shoppers drug mart toronto', 'wal mart toronto', 'starbucks toronto',
  'woofgang bakery', 'drip house cafe',
];
const stop = inferLocationTokens(keys, { minKeys: 4, maxShare: 0.02 });
if (!stop.has('toronto')) fail.push('"toronto" must be inferred as a location');
if (stop.has('woofgang')) fail.push('a single-merchant token must never be a location');
if (stop.has('nodo')) fail.push('a leading merchant token must never be a location');

// --- stripping --------------------------------------------------------------
if (stripLocations('winners toronto', stop) !== 'winners') fail.push('trailing location must be stripped');
// Position 0 is the merchant name even when it is also a place.
if (stripLocations('toronto parking authority', stop) !== 'toronto parking authority') {
  fail.push('a leading location token must be preserved — it is the merchant name');
}
// Never strip a key down to nothing.
if (stripLocations('toronto', stop) !== 'toronto') fail.push('must never empty a key');

// --- the point of all this: branches collapse, neighbours separate -----------
const before = similarity(normalizePayee('NODO LESLIEVILLE TORONTO'), normalizePayee('WOOF GANG LESLIEVILLE TORONTO'));
const after = similarity(
  stripLocations(normalizePayee('NODO LESLIEVILLE TORONTO'), stop),
  stripLocations(normalizePayee('WOOF GANG LESLIEVILLE TORONTO'), stop)
);
if (!(after < before)) fail.push(`stripping must separate unrelated merchants sharing a location (${before.toFixed(2)} -> ${after.toFixed(2)})`);
if (after >= 0.7) fail.push(`two unrelated merchants must not match after stripping (got ${after.toFixed(2)})`);

// Same merchant, two branches, must collapse to one entry.
// The inference is statistical, so it needs a realistic spread of merchants
// across cities — that is what makes a city token stand out from a name.
const tx = (payee, category_id) => ({ payee, original_name: payee, category_id, date: '2026-08-01' });
const CITIES = ['TORONTO', 'ETOBICOKE', 'SCARBOROUGH'];
const MERCHANTS = [
  ['WINNERS', 50], ['IKEA', 51], ['FARM BOY', 52], ['STARBUCKS', 53],
  ['SHOPPERS DRUG MART', 54], ['LOBLAWS', 55], ['CANADIAN TIRE', 56], ['METRO', 57],
];
const corpus = [];
for (const [name, cat] of MERCHANTS) {
  for (const city of CITIES) {
    for (let i = 0; i < 3; i++) corpus.push(tx(`${name} #${i} ${city}`, cat));
  }
}
const mem = Memory.build(corpus);

if (!mem.stopTokens.has('toronto')) fail.push('"toronto" must be inferred from a realistic corpus');
if (!mem.stopTokens.has('etobicoke')) fail.push('"etobicoke" must be inferred from a realistic corpus');

// All three branches collapse into one entry with the combined history.
if (Object.keys(mem.entries).length !== MERCHANTS.length) {
  fail.push(`expected one entry per merchant, got ${Object.keys(mem.entries).length}`);
}
const winners = mem.match(tx('WINNERS #99 TORONTO'));
if (!winners) fail.push('a known merchant must match');
else if (winners.categoryId !== 50) fail.push(`wrong category: ${winners.categoryId}`);
else if (winners.observations !== 9) fail.push(`three branches should merge into 9 observations, got ${winners.observations}`);

// A city the corpus has never seen is NOT stripped, so the merchant falls
// through to the next tier rather than being guessed at. This is deliberate:
// no string rule can tell "winners" -> "winners mississauga" (same merchant,
// new city) from "amazon" -> "amazon web services" (different merchant), and
// a wrong category is worse than none. The LLM tier sees the raw descriptor.
const unseenCity = mem.match(tx('WINNERS #99 MISSISSAUGA'));
if (unseenCity) fail.push('an unseen city must not produce a confident memory match');

// Different merchants in the same city must NOT collapse into each other.
const ikea = mem.match(tx('IKEA #4 TORONTO'));
if (ikea?.categoryId !== 51) fail.push('a different merchant in a shared city must keep its own category');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ locations: 13 assertions passed');
process.exit(fail.length ? 1 : 0);
