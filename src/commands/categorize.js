import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { Cascade } from '../classify.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool } from '../args.js';
import { table, color, money, truncate, pct, confirm } from '../util.js';

export async function categorize(flags) {
  const range = resolveDateRange(flags, { defaultDays: 90 });
  const limit = num(flags.limit, null);
  const apply = bool(flags.apply, false);
  const useLlm = bool(flags.llm, true);
  const minConfidence = num(flags['min-confidence'], 0.7);
  const markReviewed = bool(flags['mark-reviewed'], false);
  const includeReviewed = bool(flags['include-reviewed'], false);
  const verbose = bool(flags.verbose ?? flags.v, false);
  const batchSize = num(flags['batch-size'], 25);

  const lm = new LunchMoney({ verbose });

  console.log(color('bold', '\nLunch Money auto-categorizer'));
  console.log(color('dim', `range: ${range.label}${limit ? ` · limit ${limit}` : ''}`));

  const kb = await CategoryKB.load(lm);
  const s = kb.summary();
  console.log(
    color('dim', `categories: ${s.assignable} assignable across ${s.groups} groups (${s.income} income)`)
  );

  const cascade = await Cascade.create({
    kb,
    useLlm,
    minConfidence,
    verbose,
    warn: (msg) => console.error(color('yellow', `  ⚠ rules.json — ${msg}`)),
  });
  const cstats = cascade.stats();
  console.log(
    color('dim', `tiers: ${cstats.rules} rules · ${cstats.memory} learned payees · ${cstats.llm ?? 'llm disabled'}`)
  );

  // Only uncategorized transactions are candidates. By default we also require
  // them to be unreviewed, so anything the user has already looked at is left alone.
  const query = { category_id: 0, include_pending: false };
  if (!includeReviewed) query.status = 'unreviewed';
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, { max: limit });
  console.log(color('dim', `${fetched.length} found`));

  // Groups and split parents cannot be updated through this endpoint.
  const candidates = fetched.filter(
    (tx) => tx.category_id == null && !tx.is_group_parent && !tx.is_split_parent
  );
  const excluded = fetched.length - candidates.length;
  if (excluded > 0) {
    console.log(color('dim', `  (${excluded} skipped: grouped or split transactions can't be updated)`));
  }

  if (!candidates.length) {
    console.log(color('green', '\n✓ Nothing to categorize — everything in range is already categorized.\n'));
    return;
  }

  const { suggestions, undecided } = await cascade.run(candidates, {
    llmBatchSize: batchSize,
    onLlmProgress: (done, total) =>
      process.stdout.write(`\r${color('dim', `  llm batch ${done}/${total}…`)}`),
  });
  if (cascade.classifier?.usage.calls) process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const rows = candidates
    .filter((tx) => suggestions.has(tx.id))
    .map((tx) => ({ tx, suggestion: suggestions.get(tx.id) }));

  if (!rows.length) {
    console.log(color('yellow', `\nNo confident suggestions for ${candidates.length} transactions.`));
    console.log(color('dim', 'Try lowering --min-confidence, or run `lmbot learn` to build the memory tier.\n'));
    return;
  }

  console.log('\n' + table(rows, [
    { header: 'DATE', get: (r) => r.tx.date },
    { header: 'AMOUNT', right: true, get: (r) => money(r.tx.amount, r.tx.currency) },
    { header: 'PAYEE', get: (r) => truncate(r.tx.payee || r.tx.original_name, 34) },
    { header: 'CATEGORY', get: (r) => truncate(kb.label(r.suggestion.categoryId), 30) },
    { header: 'VIA', get: (r) => r.suggestion.tier },
    { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
    { header: 'WHY', get: (r) => truncate(r.suggestion.reason, 40) },
  ]));

  const byTier = rows.reduce((acc, r) => {
    acc[r.suggestion.tier] = (acc[r.suggestion.tier] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    '\n' +
      color('bold', `${rows.length} of ${candidates.length} categorized `) +
      color('dim', `(${Object.entries(byTier).map(([t, n]) => `${n} by ${t}`).join(', ')})`)
  );
  if (undecided.length) {
    console.log(color('dim', `${undecided.length} left uncategorized — below the ${pct(minConfidence)} confidence floor.`));
  }
  if (cascade.classifier?.usage.calls) console.log(color('dim', cascade.classifier.costNote()));

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was written. Re-run with --apply to commit.\n'));
    return;
  }

  const updates = rows.map(({ tx, suggestion }) => {
    const update = { id: tx.id, category_id: suggestion.categoryId };
    const review = suggestion.review ?? markReviewed;
    if (review) update.status = 'reviewed';
    if (suggestion.notes) update.notes = suggestion.notes;
    return update;
  });

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(`Apply ${updates.length} categor${updates.length === 1 ? 'y' : 'ies'} in Lunch Money?`);
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was written.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'categorize',
    rows.map(({ tx, suggestion }) => ({
      id: tx.id,
      date: tx.date,
      payee: tx.payee,
      previous: { category_id: tx.category_id, status: tx.status },
      applied: { category_id: suggestion.categoryId, tier: suggestion.tier, reason: suggestion.reason },
    })),
    { range: range.label }
  );

  await lm.updateTransactions(updates);
  console.log(color('green', `\n✓ Updated ${updates.length} transactions.`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
