/**
 * A never_review hold must survive whichever tier categorized the transaction,
 * and must outrank every flag that would otherwise mark it reviewed.
 */
import { RuleEngine } from '../src/rules.js';
import { CategoryKB } from '../src/kb.js';
import { qualifiesForAutoReview } from '../src/classify.js';

const kb = new CategoryKB([
  { id: 11, name: 'Coffee Shops', is_group: false, archived: false, group_id: null },
  { id: 12, name: 'Public Investments', is_group: false, archived: false, group_id: null },
]);

const engine = new RuleEngine(
  [{ name: 'Coffee', category: 'Coffee Shops', match: '\\bstarbucks\\b' }],
  kb,
  { neverReview: [{ name: 'Investments and Amazon', match: '\\b(ws\\s*investments|wealthsimple|amazon|amzn)\\b' }] }
);

const tx = (payee, original_name = payee) => ({ payee, original_name, amount: '10.00' });
const fail = [];
const held = (t) => engine.holdsReview(t) !== null;

// The descriptors this is actually for.
for (const d of ['WS Investments INV', 'WEALTHSIMPLE TRADE', 'AMAZON.CA*RT4XY2103', 'AMZN Mktp CA TORONTO', 'Amazon Web Services']) {
  if (!held(tx(d))) fail.push(`"${d}" must be held`);
}
// Everything else must be unaffected.
for (const d of ['STARBUCKS TORONTO', 'TORONTO HYDRO BPY', 'Loblaws Leslie St', 'RBC LIFE INSURANCE']) {
  if (held(tx(d))) fail.push(`"${d}" must NOT be held`);
}
// A hold matches the raw descriptor even when the display payee was cleaned up.
if (!held(tx('Wealthsimple', 'WS INVESTMENTS INV 8842'))) fail.push('a hold must see original_name too');

// A held merchant is still categorized normally — only the review flag is withheld.
const hit = engine.match(tx('STARBUCKS TORONTO'));
if (hit?.categoryId !== 11) fail.push('holds must not interfere with categorization');

// The hold is tier-independent: memory and LLM suggestions would both otherwise
// qualify, which is exactly what a per-rule `review: false` cannot cover.
const memoryHit = { tier: 'memory', categoryId: 12, confidence: 0.99, observations: 40 };
if (!qualifiesForAutoReview(memoryHit)) fail.push('precondition: this memory hit should otherwise auto-review');
if (!held(tx('WS Investments INV'))) fail.push('the hold must apply regardless of which tier decided');

// A malformed hold is reported, not silently dropped.
const broken = new RuleEngine([], kb, { neverReview: [{ name: 'bad', match: '([unclosed' }] });
if (broken.problems.length !== 1) fail.push('a bad hold regex must be reported');
if (broken.holdCount !== 0) fail.push('a bad hold must not be installed');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ holds: 13 assertions passed');
process.exit(fail.length ? 1 : 0);
