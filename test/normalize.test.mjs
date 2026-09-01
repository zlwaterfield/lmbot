import { normalizePayee, similarity } from '../src/normalize.js';

const cases = [
  ['SQ *BLUE BOTTLE 4471', 'blue bottle'],
  ['BLUE BOTTLE COFFEE #12 OAKLAND CA', 'blue bottle coffee'],
  ['Whole Foods Market 10287 SAN FRANCISCO CA', 'whole foods market'],
  ['SAFEWAY #1234 NEW YORK NY', 'safeway'],
  ['Netflix.com', 'netflix'],
  ['TST* CHIPOTLE 2094', 'chipotle'],
  ['', ''],
];

const fail = [];
for (const [input, expected] of cases) {
  const got = normalizePayee(input);
  if (got !== expected) fail.push(`normalizePayee(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

// Similar merchants must score high, unrelated ones low.
const pairs = [
  ['whole foods market', 'wholefoods mkt', 0.6, 'above'],
  ['blue bottle', 'blue bottle coffee', 0.6, 'above'],
  ['shell oil', 'chipotle austin', 0.6, 'below'],
  ['target', 'trader joes', 0.6, 'below'],
];
for (const [a, b, threshold, dir] of pairs) {
  const s = similarity(a, b);
  const ok = dir === 'above' ? s >= threshold : s < threshold;
  if (!ok) fail.push(`similarity(${a}, ${b}) = ${s.toFixed(2)}, expected ${dir} ${threshold}`);
}

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : `✓ normalize: ${cases.length + pairs.length} assertions passed`);
process.exit(fail.length ? 1 : 0);
