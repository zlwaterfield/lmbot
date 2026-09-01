/**
 * `exclude` exists because a useful pattern is often slightly too broad:
 * "rent" should find a rent payment but not Enterprise Rent-A-Car.
 */
import { RuleEngine } from '../src/rules.js';
import { CategoryKB } from '../src/kb.js';

const kb = new CategoryKB([
  { id: 11, name: 'Mortgage / Rent', is_group: false, archived: false, group_id: null },
  { id: 12, name: 'Groceries', is_group: false, archived: false, group_id: null },
]);

const engine = new RuleEngine([
  {
    name: 'Mortgage',
    category: 'Mortgage / Rent',
    match: '\\b(mortgage|rent)\\b',
    exclude: '\\b(rent\\s*[-\\s]?a[-\\s]?car|enterprise|avis|hertz)\\b',
  },
  { name: 'Groceries', category: 'Groceries', match: '\\bloblaws\\b' },
], kb, {});

const tx = (payee) => ({ payee, original_name: payee, amount: '900.00' });
const fail = [];
const hit = (p) => engine.match(tx(p))?.name ?? null;

for (const [payee, want] of [
  ['mortgage payment', 'Mortgage'],
  ['RENT PAYMENT 2154.97', 'Mortgage'],
  ['ENTERPRISE RENT-A-CAR TORONTO', null],
  ['AVIS RENT A CAR', null],
  ['HERTZ RENT A CAR', null],
  ['LOBLAWS LESLIE ST', 'Groceries'],
]) {
  const got = hit(payee);
  if (got !== want) fail.push(`${JSON.stringify(payee)} matched ${got}, want ${want}`);
}

// An excluded transaction must fall through to later tiers, not be swallowed.
if (engine.match(tx('ENTERPRISE RENT-A-CAR')) !== null) fail.push('an excluded match must return null so lower tiers still run');

// A rule without `exclude` behaves exactly as before.
const plain = new RuleEngine([{ name: 'R', category: 'Groceries', match: '\\bloblaws\\b' }], kb, {});
if (plain.match(tx('LOBLAWS'))?.categoryId !== 12) fail.push('a rule without exclude must be unaffected');

// A bad exclude regex is reported rather than silently ignored.
const broken = new RuleEngine([{ name: 'B', category: 'Groceries', match: '\\bx\\b', exclude: '([unclosed' }], kb, {});
if (broken.size !== 0 || broken.problems.length !== 1) fail.push('a bad exclude regex must be reported and the rule dropped');

// The JSON escaping trap applies to exclude too.
const ctrl = new RuleEngine([{ name: 'C', category: 'Groceries', match: '\\bx\\b', exclude: '\ba' }], kb, {});
if (ctrl.size !== 0) fail.push('a control character in exclude must be caught');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ exclude: 10 assertions passed');
process.exit(fail.length ? 1 : 0);
