import { cleanPayee, cleanliness, clusterByPayee, canonicalFor } from '../src/payees.js';

const fail = [];

// --- cleanPayee -------------------------------------------------------------
const clean = [
  ['STARBUCKS 8007827282    800-782-7282', 'Starbucks'],
  ['SQ *BLUE BOTTLE 4471', 'Blue Bottle'],
  ['WHOLE FOODS MARKET 10287 SAN FRANCISCO CA', 'Whole Foods Market'],
  ['AMAZON.COM*RT4XY2103 AMZN.COM/BILL WA', 'Amazon'],
  ['TST* CHIPOTLE 2094', 'Chipotle'],
  ['NETFLIX.COM', 'Netflix'],
  ['MCDONALDS F1234 AUSTIN TX', "McDonald's"],
  ['PAYPAL *SPOTIFY USA INC', 'Spotify USA'],
  ['ATT*BILL PAYMENT 800-331-0500', 'AT&T Bill Payment'],
  ['iPhone Repair Co', 'iPhone Repair'],   // "Co" is Company here, not Colorado
  ['Blue Bottle', 'Blue Bottle'],          // already clean, unchanged
];
for (const [input, expected] of clean) {
  const got = cleanPayee(input);
  if (got !== expected) fail.push(`cleanPayee(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
}

// --- cleanliness ------------------------------------------------------------
if (cleanliness('Blue Bottle') <= cleanliness('SQ *BLUE BOTTLE 4471')) fail.push('clean name must outscore raw descriptor');
if (cleanliness('IKEA') < 90) fail.push('short all-caps acronyms must not be penalized');
if (cleanliness('NETFLIX.COM') >= 85) fail.push('long all-caps must score below the keep-as-is threshold');

// --- clustering & merging ---------------------------------------------------
const tx = (id, payee, original_name) => ({
  id, date: '2026-08-01', amount: '5.00', currency: 'usd', payee, original_name,
  is_split_parent: false, split_parent_id: null, is_group_parent: false, group_parent_id: null,
});

const clusters = clusterByPayee([
  tx(1, 'STARBUCKS 8007827282    800-782-7282', 'STARBUCKS 8007827282    800-782-7282'),
  tx(2, 'STARBUCKS STORE 09876 AUSTIN TX', 'STARBUCKS STORE 09876 AUSTIN TX'),
  tx(3, 'SQ *BLUE BOTTLE 4471', 'SQ *BLUE BOTTLE 4471'),
  tx(4, 'SQ *BLUE BOTTLE COFFEE 8823', 'SQ *BLUE BOTTLE COFFEE 8823'),
  tx(5, 'Amazon', 'AMAZON.COM*RT4 AMZN.COM/BILL WA'),
  tx(6, 'Amazon Web Services', 'AMAZON WEB SERVICES AWS.AMAZON.COM WA'),
]);

const findCluster = (needle) => clusters.find((cl) => cl.keys.some((k) => k.includes(needle)));
const starbucks = findCluster('starbucks');
const bluebottle = findCluster('blue bottle');

if (!starbucks || starbucks.transactions.length !== 2) fail.push('Starbucks variants should form one cluster');
if (!bluebottle || bluebottle.transactions.length !== 2) fail.push('Blue Bottle variants should merge into one cluster');

// The conservative merge must NOT collapse genuinely different merchants.
const amazonClusters = clusters.filter((cl) => cl.keys.some((k) => k.startsWith('amazon')));
if (amazonClusters.length !== 2) fail.push('Amazon and Amazon Web Services must stay separate');

// --- canonical selection ----------------------------------------------------
if (canonicalFor(starbucks).name !== 'Starbucks') fail.push(`Starbucks canonical wrong: ${canonicalFor(starbucks).name}`);
if (canonicalFor(bluebottle).name !== 'Blue Bottle') fail.push(`Blue Bottle canonical wrong: ${canonicalFor(bluebottle).name}`);

const aliased = canonicalFor(starbucks, { starbucks: 'Starbucks Coffee' });
if (aliased.tier !== 'alias' || aliased.name !== 'Starbucks Coffee') fail.push('saved alias must win over the heuristic');

// A name the user already typed cleanly must be preserved, not regenerated.
const userNamed = clusterByPayee([tx(7, 'Trader Joe’s', 'TRADER JOES #123 LOS ANGELES CA'), tx(8, 'Trader Joe’s', 'TRADER JOES #456 SAN DIEGO CA')])[0];
if (canonicalFor(userNamed).tier !== 'existing') fail.push('a clean user-typed name must be kept as-is');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : `✓ payees: ${clean.length + 11} assertions passed`);
process.exit(fail.length ? 1 : 0);
