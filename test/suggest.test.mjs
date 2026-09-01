import { CategoryKB } from '../src/kb.js';

const C = (id, name, group_id = null, is_group = false) => ({ id, name, is_group, archived: false, group_id });
// Category names shaped like a real account: specific, grouped, punctuated.
const kb = new CategoryKB([
  C(1, 'Food & Drink', null, true), C(11, 'Coffee Shops', 1), C(12, 'Restaurants', 1), C(13, 'Groceries', 1),
  C(2, 'Transport', null, true), C(21, 'Uber / Lift / Taxi', 2), C(22, 'Transportation Other', 2),
  C(31, 'Subscriptions/Software (business)'), C(41, "Zach's Income"), C(51, 'Mortgage / Rent'),
  C(61, 'Home Utility Bill'), C(71, 'Archived Thing'),
]);

const fail = [];
const first = (q) => kb.suggest(q)[0];

// The generic names the example rules ship with must point at the real ones.
const expected = [
  ['Coffee', 'Food & Drink > Coffee Shops'],
  ['Subscriptions', 'Subscriptions/Software (business)'],
  ['Income', "Zach's Income"],
  ['Rent', 'Mortgage / Rent'],          // whole-word containment, not token overlap
  ['Utilities', 'Home Utility Bill'],
];
for (const [query, want] of expected) {
  const got = first(query);
  if (got !== want) fail.push(`suggest(${JSON.stringify(query)})[0] = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// A group name must not tie across every category inside that group. Real
// accounts name groups like "2c. Transportation", and path-only matching made
// every child score identically and report a false ambiguity.
const grouped = new CategoryKB([
  C(1, '2c. Transportation', null, true), C(11, 'Uber / Lift / Taxi', 1),
  C(12, 'Transportation Other', 1), C(13, 'Gas', 1),
  C(2, '3a. Personal/Enterainment', null, true), C(21, 'Streaming', 2),
  C(3, '2a. Housing', null, true), C(31, 'Mortgage / Rent', 3), C(32, 'Home Utility Bill', 3),
]);
const transport = grouped.suggest('Transportation');
if (transport[0] !== '2c. Transportation > Transportation Other') {
  fail.push(`the leaf name must win over the group path, got ${JSON.stringify(transport)}`);
}
if (transport.length > 1) fail.push('a clear leader must not be reported as ambiguous');
if (grouped.suggest('Utilities')[0] !== '2a. Housing > Home Utility Bill') fail.push('"Utilities" must find "Home Utility Bill" inside a numbered group');
if (grouped.suggest('Streaming')[0] !== '3a. Personal/Enterainment > Streaming') fail.push('an exact leaf inside a group must be found');

// Two genuinely equal candidates must still both be reported, so autofix defers.
const tie = new CategoryKB([C(1, 'Coffee Shops'), C(2, 'Coffee Beans')]);
if (tie.suggest('Coffee').length < 2) fail.push('two equally plausible categories must stay ambiguous');

// Nonsense must return nothing rather than the least-bad guess.
if (kb.suggest('Nonsense XYZ').length !== 0) fail.push('an unrelated name must produce no suggestion');

// An exact name still resolves normally and needs no suggesting.
if (kb.resolve('Coffee Shops') !== 11) fail.push('an exact name must resolve');
if (kb.resolve('Food & Drink > Coffee Shops') !== 11) fail.push('a full path must resolve');
if (kb.resolve('Nope') !== null) fail.push('an unknown name must resolve to null');

// Built-in placeholder defaults that this account lacks must not be "explicit",
// so they are ignored silently instead of warned about.
const cfg = CategoryKB.loadPlaceholderNames('/nonexistent/placeholders.json');
if (cfg.explicit !== false) fail.push('built-in defaults must not be reported as explicit');
if (!cfg.names.includes('Payment, Transfer')) fail.push('defaults must include the common import placeholder');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ suggest: 12 assertions passed');
process.exit(fail.length ? 1 : 0);
