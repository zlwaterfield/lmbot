import { CategoryKB, DEFAULT_PLACEHOLDERS } from '../src/kb.js';

const kb = new CategoryKB([
  { id: 10, name: 'Food', is_group: true, archived: false, group_id: null },
  { id: 11, name: 'Coffee', is_group: false, archived: false, group_id: 10 },
  { id: 90, name: 'Payment, Transfer', is_group: false, archived: false, group_id: null },
  { id: 91, name: 'Transfer', is_group: false, archived: false, group_id: null },
  { id: 92, name: 'Other', is_group: false, archived: false, group_id: null },
]);

const fail = [];

// The Plaid import default is caught by the shipped defaults...
const def = kb.resolvePlaceholders(DEFAULT_PLACEHOLDERS);
if (!def.ids.has(90)) fail.push('"Payment, Transfer" must be a default placeholder');
if (!def.ids.has(92)) fail.push('"Other" must be a default placeholder');

// ...but a plain "Transfer" the user chose on purpose must NOT be.
if (def.ids.has(91)) fail.push('a deliberately-chosen "Transfer" category must not be a placeholder');
if (def.ids.has(11)) fail.push('a real category must never be a placeholder');

// Comma-containing names must survive intact.
const comma = kb.resolvePlaceholders(['Payment, Transfer']);
if (!comma.ids.has(90) || comma.unmatched.length) fail.push('comma-containing category name must resolve');

// Naming a group covers its children.
const group = kb.resolvePlaceholders(['Food']);
if (!group.ids.has(11)) fail.push('naming a group must cover its children');

// Ids and full paths both work.
if (!kb.resolvePlaceholders([91]).ids.has(91)) fail.push('numeric id must resolve');
if (!kb.resolvePlaceholders(['Food > Coffee']).ids.has(11)) fail.push('full path must resolve');

// A typo is reported, not silently ignored — otherwise the feature would
// appear to work while quietly doing nothing.
const typo = kb.resolvePlaceholders(['Paymnet, Transfer']);
if (typo.ids.size !== 0 || typo.unmatched.length !== 1) fail.push('an unmatched name must be reported');

// Defaults must not accidentally match nothing on an account without them.
const bare = new CategoryKB([{ id: 1, name: 'Coffee', is_group: false, archived: false, group_id: null }]);
if (bare.resolvePlaceholders(DEFAULT_PLACEHOLDERS).ids.size !== 0) fail.push('defaults must match nothing on an account without them');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ placeholders: 10 assertions passed');
process.exit(fail.length ? 1 : 0);

// --- the LLM must never be offered an import-default category ----------------
{
  const withPlaceholder = new CategoryKB([
    { id: 11, name: 'Coffee', is_group: false, archived: false, group_id: null },
    { id: 90, name: 'Payment, Transfer', is_group: false, archived: false, group_id: null },
  ]);
  const exclude = withPlaceholder.resolvePlaceholders(['Payment, Transfer']).ids;
  const prompt = withPlaceholder.toPrompt(exclude);
  const bad = [];
  if (prompt.includes('id=90')) bad.push('placeholder category must be absent from the LLM prompt');
  if (!prompt.includes('id=11')) bad.push('real categories must still be present');
  if (bad.length) { console.log('✗ ' + bad.join('\n✗ ')); process.exit(1); }
  console.log('✓ placeholders: 2 LLM-prompt assertions passed');
}
