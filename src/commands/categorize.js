import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { isEditable } from '../normalize.js';
import { Cascade, qualifiesForAutoReview } from '../classify.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool, list } from '../args.js';
import { table, color, money, truncate, pct, confirm } from '../util.js';

export async function categorize(flags) {
  const range = resolveDateRange(flags, { defaultDays: 90 });
  const limit = num(flags.limit, null);
  const apply = bool(flags.apply, false);
  const useLlm = bool(flags.llm, true);
  const minConfidence = num(flags['min-confidence'], 0.7);
  const markReviewed = bool(flags['mark-reviewed'], false);
  const autoReview = bool(flags['auto-review'], false);
  const autoReviewOpts = {
    minConfidence: num(flags['auto-review-min'], 0.9),
    minObservations: num(flags['auto-review-observations'], 3),
    allowLlm: bool(flags['auto-review-llm'], false),
  };
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

  // A sync assigns a default category to everything it imports, so "has a
  // category" is not the same as "somebody categorized it". While a transaction
  // is still unreviewed, sitting in one of those defaults means nothing.
  const usePlaceholders = bool(flags.placeholders, true);
  const placeholderNames = list(flags.placeholder);
  const { ids: placeholderIds, matched, unmatched } = usePlaceholders
    ? kb.resolvePlaceholders(placeholderNames.length ? placeholderNames : CategoryKB.loadPlaceholderNames())
    : { ids: new Set(), matched: [], unmatched: [] };

  if (matched.length) {
    console.log(color('dim', `treating as uncategorized: ${matched.join(', ')}`));
  }
  if (unmatched.length) {
    console.log(color('yellow', `  ⚠ no category named ${unmatched.map((n) => JSON.stringify(n)).join(', ')} — ignored`));
    console.log(color('dim', '    run `lmbot categories --usage` to see the real names'));
  }

  const cascade = await Cascade.create({
    kb,
    useLlm,
    minConfidence,
    verbose,
    excludeIds: placeholderIds,
    warn: (msg) => console.error(color('yellow', `  ⚠ rules.json — ${msg}`)),
  });
  const cstats = cascade.stats();
  console.log(
    color('dim', `tiers: ${cstats.rules} rules · ${cstats.memory} learned payees · ${cstats.llm ?? 'llm disabled'}`)
  );

  const query = { include_pending: false };
  if (!includeReviewed) query.status = 'unreviewed';
  // The server-side category_id=0 filter would hide placeholder-categorized
  // transactions, so it is only safe when no placeholders are in play.
  if (!placeholderIds.size) query.category_id = 0;
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, {
    // With placeholders active the filtering happens client-side, so --limit
    // must cap candidates rather than the fetch, or it would truncate early.
    max: placeholderIds.size ? null : limit,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  console.log(`\r${color('dim', `fetched ${fetched.length} transactions`)}            `);

  const isBlank = (tx) => tx.category_id == null;
  const isPlaceholder = (tx) => tx.category_id != null && placeholderIds.has(tx.category_id);

  // Split and grouped transactions are rejected by the bulk update endpoint.
  const eligible = fetched.filter((tx) => (isBlank(tx) || isPlaceholder(tx)) && isEditable(tx));
  const blankCount = eligible.filter(isBlank).length;
  const placeholderCount = eligible.filter(isPlaceholder).length;
  const candidates = limit ? eligible.slice(0, limit) : eligible;

  if (placeholderCount) {
    console.log(
      color('dim', `  ${blankCount} with no category, ${placeholderCount} in a placeholder category`)
    );
  }
  const skipped = fetched.filter((tx) => (isBlank(tx) || isPlaceholder(tx)) && !isEditable(tx)).length;
  if (skipped > 0) {
    console.log(color('dim', `  (${skipped} skipped: grouped or split transactions can't be updated)`));
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

  const reviewFor = (suggestion) =>
    // An explicit per-rule setting wins, then --mark-reviewed marks everything,
    // then --auto-review applies its tier and evidence gate.
    suggestion.review ??
    (markReviewed ? true : autoReview && qualifiesForAutoReview(suggestion, autoReviewOpts));

  const suggested = candidates
    .filter((tx) => suggestions.has(tx.id))
    .map((tx) => ({ tx, suggestion: suggestions.get(tx.id) }));

  // A suggestion identical to the category already on the transaction needs no
  // write. Counted separately so every candidate is accounted for.
  const unchanged = suggested.filter(({ tx, suggestion }) => suggestion.categoryId === tx.category_id);
  const rows = suggested.filter(({ tx, suggestion }) => suggestion.categoryId !== tx.category_id);

  if (!rows.length) {
    console.log(color('yellow', `\nNo confident suggestions for ${candidates.length} transactions.`));
    console.log(color('dim', 'Try lowering --min-confidence, or run `lmbot learn` to build the memory tier.\n'));
    return;
  }

  console.log('\n' + table(rows, [
    { header: 'DATE', get: (r) => r.tx.date },
    { header: 'AMOUNT', right: true, get: (r) => money(r.tx.amount, r.tx.currency) },
    { header: 'PAYEE', get: (r) => truncate(r.tx.payee || r.tx.original_name, 34) },
    { header: 'CURRENT', get: (r) => (r.tx.category_id == null ? '—' : truncate(kb.label(r.tx.category_id), 20)) },
    { header: 'CATEGORY', get: (r) => truncate(kb.label(r.suggestion.categoryId), 28) },
    { header: 'VIA', get: (r) => r.suggestion.tier },
    { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
    { header: 'REVIEWED', get: (r) => (reviewFor(r.suggestion) ? 'yes' : '') },
    { header: 'WHY', get: (r) => truncate(r.suggestion.reason, 36) },
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
  const willReview = rows.filter((r) => reviewFor(r.suggestion)).length;
  if (willReview) {
    console.log(
      color('dim', `${willReview} will also be marked reviewed`) +
        color('dim', autoReview && !markReviewed
          ? ` (rules, plus memory seen ≥${autoReviewOpts.minObservations}× at ≥${pct(autoReviewOpts.minConfidence)})`
          : '')
    );
  }
  // Every candidate lands in exactly one of these buckets.
  if (unchanged.length) {
    console.log(
      color('dim', `${unchanged.length} already in the suggested category — nothing to change`)
    );
  }
  if (undecided.length) {
    console.log(
      color('dim', `${undecided.length} with no confident suggestion — below the ${pct(minConfidence)} floor`)
    );
  }
  const accounted = rows.length + unchanged.length + undecided.length;
  if (accounted !== candidates.length) {
    console.log(color('yellow', `  ⚠ ${candidates.length - accounted} unaccounted for — please report this`));
  }
  if (cascade.poisoned.length) {
    const tiers = [...new Set(cascade.poisoned.map((p) => p.tier))].join(', ');
    console.log(
      color('yellow', `\n${cascade.poisoned.length} suggestion${cascade.poisoned.length === 1 ? ' was' : 's were'} dropped for naming an import-default category (from: ${tiers}).`)
    );
    if (tiers.includes('memory')) {
      console.log(color('dim', '  Your memory was built before those were excluded — re-run `lmbot learn` to clear it.'));
    }
    if (tiers.includes('rule')) {
      console.log(color('dim', '  A rule in data/rules.json points at a placeholder category.'));
    }
  }
  if (cascade.classifier?.usage.calls) console.log(color('dim', cascade.classifier.costNote()));

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was written. Re-run with --apply to commit.\n'));
    return;
  }

  const updates = rows.map(({ tx, suggestion }) => {
    const update = { id: tx.id, category_id: suggestion.categoryId };
    if (reviewFor(suggestion)) update.status = 'reviewed';
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
