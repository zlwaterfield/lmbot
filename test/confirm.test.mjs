import { partitionByAgreement } from '../src/commands/confirm.js';

const tx = (id, category_id) => ({ id, category_id });
const candidates = [tx(1, 101), tx(2, 101), tx(3, 102), tx(4, 103), tx(5, 104)];
const suggestions = new Map([
  [1, { tier: 'rule',   categoryId: 101, confidence: 1.0 }],  // agrees, confident
  [2, { tier: 'memory', categoryId: 101, confidence: 0.6 }],  // agrees, too weak
  [3, { tier: 'llm',    categoryId: 999, confidence: 0.95 }], // disagrees
  [4, { tier: 'memory', categoryId: 103, confidence: 0.99 }], // agrees, confident
  // 5 has no suggestion at all
]);

const { agree, weak, disagree, unsure } = partitionByAgreement(candidates, suggestions, 0.8);
const fail = [];
const ids = (rows) => rows.map((r) => r.tx.id).join(',');

if (ids(agree) !== '1,4') fail.push(`agree should be 1,4 — got ${ids(agree)}`);
if (ids(weak) !== '2') fail.push(`weak should be 2 — got ${ids(weak)}`);
if (ids(disagree) !== '3') fail.push(`disagree should be 3 — got ${ids(disagree)}`);
if (ids(unsure) !== '5') fail.push(`unsure should be 5 — got ${ids(unsure)}`);

// Every candidate must land in exactly one bucket, or the summary lies.
const total = agree.length + weak.length + disagree.length + unsure.length;
if (total !== candidates.length) fail.push(`buckets sum to ${total}, expected ${candidates.length}`);

// A disagreement must never be silently confirmed, however confident it is.
if (agree.some((r) => r.suggestion.categoryId !== r.tx.category_id)) {
  fail.push('a category change must never reach the agree bucket');
}

// Threshold is honored in both directions.
const strict = partitionByAgreement(candidates, suggestions, 0.999);
if (strict.agree.length !== 1) fail.push('a stricter floor must shrink the agree set');
const loose = partitionByAgreement(candidates, suggestions, 0.5);
if (loose.agree.length !== 3) fail.push('a looser floor must grow the agree set');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ confirm: 8 assertions passed');
process.exit(fail.length ? 1 : 0);
