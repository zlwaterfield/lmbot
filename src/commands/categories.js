import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { bool, num, resolveDateRange } from '../args.js';
import { color, table, truncate } from '../util.js';

/** Show the knowledge base — the exact category context the LLM tier receives. */
export async function categories(flags) {
  const lm = new LunchMoney({ verbose: bool(flags.verbose ?? flags.v, false) });
  const kb = await CategoryKB.load(lm);

  if (bool(flags.prompt, false)) {
    console.log(kb.toPrompt());
    return;
  }

  if (bool(flags.json, false)) {
    console.log(JSON.stringify(kb.assignable, null, 2));
    return;
  }

  if (bool(flags.usage, false)) return usage(lm, kb, flags);

  const s = kb.summary();
  console.log(color('bold', '\nCategory knowledge base'));
  console.log(
    color('dim', `${s.assignable} assignable · ${s.groups} groups · ${s.income} income · ${s.archived} archived (excluded)\n`)
  );

  const rows = [...kb.assignable].sort((a, b) => kb.path(a).localeCompare(kb.path(b)));
  console.log(table(rows, [
    { header: 'ID', right: true, get: (cat) => cat.id },
    { header: 'CATEGORY', get: (cat) => truncate(kb.path(cat), 44) },
    { header: 'FLAGS', get: (cat) =>
      [cat.is_income ? 'income' : '', cat.exclude_from_budget ? 'no-budget' : '', cat.exclude_from_totals ? 'no-totals' : '']
        .filter(Boolean).join(',') },
    { header: 'DESCRIPTION', get: (cat) => truncate(cat.description ?? '', 40) },
  ]));
  console.log(color('dim', '\nUse `lmbot categories --prompt` to see exactly what the LLM tier is told.\n'));
}

/**
 * Where do unreviewed transactions actually sit? This is how you find the
 * import-default categories worth listing as placeholders — a sync dumping
 * everything into "Payment, Transfer" shows up immediately at the top.
 */
async function usage(lm, kb, flags) {
  const range = resolveDateRange(flags, { defaultDays: 90 });
  console.log(color('bold', '\nUnreviewed transactions by category'));
  console.log(color('dim', `range: ${range.label}`));

  const query = { status: 'unreviewed', include_pending: false };
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const transactions = await lm.getTransactions(query, {
    max: num(flags.limit, null),
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  console.log(`\r${color('dim', `fetched ${transactions.length} unreviewed transactions`)}      `);

  if (!transactions.length) {
    console.log(color('green', '\n✓ Nothing unreviewed in range.\n'));
    return;
  }

  const counts = new Map();
  for (const tx of transactions) {
    const key = tx.category_id ?? 'none';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const { ids: placeholderIds } = kb.resolvePlaceholders(CategoryKB.loadPlaceholderNames());
  const rows = [...counts.entries()]
    .map(([key, count]) => ({
      id: key,
      label: key === 'none' ? '(uncategorized)' : kb.label(key),
      count,
      treated:
        key === 'none' ? 'yes — no category' : placeholderIds.has(key) ? 'yes — placeholder' : 'no',
    }))
    .sort((a, b) => b.count - a.count);

  console.log('\n' + table(rows, [
    { header: 'COUNT', right: true, get: (r) => r.count },
    { header: 'CATEGORY', get: (r) => truncate(r.label, 40) },
    { header: 'ID', right: true, get: (r) => (r.id === 'none' ? '—' : r.id) },
    { header: 'CATEGORIZE TOUCHES IT?', get: (r) => r.treated },
  ]));

  const eligible = rows.filter((r) => r.treated !== 'no').reduce((sum, r) => sum + r.count, 0);
  console.log(
    '\n' + color('bold', `${eligible} of ${transactions.length} `) +
      color('dim', 'unreviewed transactions would be considered by `lmbot categorize`.')
  );
  console.log(
    color('dim', 'Anything above that a sync assigned by default rather than you choosing it') +
      color('dim', ' belongs in data/placeholders.json.\n')
  );
}
