import { Cascade } from '../src/classify.js';
import { Memory } from '../src/memory.js';
import { RuleEngine } from '../src/rules.js';
import { CategoryKB } from '../src/kb.js';

// --- stale category guard ----------------------------------------------------
// A category deleted or archived in Lunch Money still sits in memory.json.
// Suggesting it would send an id the account no longer has to the API.
{

  const live = new CategoryKB([
    { id: 11, name: 'Coffee Shops', is_group: false, archived: false, group_id: null },
    { id: 99, name: 'Retired Category', is_group: false, archived: true, group_id: null },
    { id: 50, name: 'A Group', is_group: true, archived: false, group_id: null },
  ]);

  const mem = new Memory({
    entries: {
      gone:     { category_id: 12345, count: 9, total: 9, share: 1 }, // deleted
      archived: { category_id: 99,    count: 9, total: 9, share: 1 }, // archived
      grouped:  { category_id: 50,    count: 9, total: 9, share: 1 }, // group, not assignable
      good:     { category_id: 11,    count: 9, total: 9, share: 1 },
    },
  });

  const cascade = new Cascade({
    kb: live,
    rules: new RuleEngine([], live, {}),
    memory: mem,
    classifier: null,
    minConfidence: 0.7,
  });

  const t = (id, payee) => ({ id, payee, original_name: payee, amount: '5.00', category_id: null });
  const { suggestions } = await cascade.run([t(1, 'gone'), t(2, 'archived'), t(3, 'grouped'), t(4, 'good')]);

  const bad = [];
  if (suggestions.has(1)) bad.push('a deleted category must never be suggested');
  if (suggestions.has(2)) bad.push('an archived category must never be suggested');
  if (suggestions.has(3)) bad.push('a group category must never be suggested');
  if (suggestions.get(4)?.categoryId !== 11) bad.push('a live category must still be suggested');
  if (cascade.stale.length !== 3) bad.push(`expected 3 stale rejections, got ${cascade.stale.length}`);
  if (bad.length) { console.log('✗ ' + bad.join('\n✗ ')); process.exit(1); }
  console.log('✓ stale categories: 5 assertions passed');
}
