import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { Cascade } from '../classify.js';
import { isEditable, payeeKey } from '../normalize.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool, list } from '../args.js';
import { table, color, money, truncate, pct, confirm } from '../util.js';

/**
 * The back-run. Re-examines transactions that already have a category and
 * surfaces the ones where the cascade strongly disagrees — the misfiled ones
 * a forward-only run would never revisit.
 *
 * The confidence floor here is deliberately higher than `categorize`: changing
 * an existing category destroys a decision the user (or a Lunch Money rule)
 * already made, so it needs more evidence than filling an empty one.
 */
export async function audit(flags) {
  const range = resolveDateRange(flags, { defaultDays: 365 });
  const limit = num(flags.limit, null);
  const apply = bool(flags.apply, false);
  const useLlm = bool(flags.llm, true);
  const minConfidence = num(flags['min-confidence'], 0.85);
  // Looking and changing are different questions. An audit is a report, so it
  // examines everything by default; writing to something you already reviewed
  // is the part that needs opting into.
  const unreviewedOnly = bool(flags['unreviewed-only'], false);
  const applyReviewed = bool(flags['include-reviewed'], false);
  const verbose = bool(flags.verbose ?? flags.v, false);

  const lm = new LunchMoney({ verbose });

  console.log(color('bold', '\nAuditing existing categories'));
  console.log(color('dim', `range: ${range.label} · disagreement threshold ${pct(minConfidence)}`));


  const kb = await CategoryKB.load(lm);

  // A transaction sitting in an import default is not miscategorized, it is
  // uncategorized — reporting every one as a "disagreement" would bury the
  // real findings. Those belong to `categorize`.
  const usePlaceholders = bool(flags.placeholders, true);
  const placeholderNames = list(flags.placeholder);
  const placeholderConfig = CategoryKB.loadPlaceholderNames();
  const { ids: placeholderIds, matched } = usePlaceholders
    ? kb.resolvePlaceholders(placeholderNames.length ? placeholderNames : placeholderConfig.names)
    : { ids: new Set(), matched: [] };
  if (matched.length) console.log(color('dim', `skipping import defaults: ${matched.join(', ')}`));

  const cascade = await Cascade.create({
    kb,
    useLlm,
    minConfidence,
    verbose,
    // Never let any tier propose an import default as a "correction".
    excludeIds: placeholderIds,
    warn: (msg) => console.error(color('yellow', `  ⚠ rules.json — ${msg}`)),
  });
  if (cascade.rules.problems.length) {
    console.error(
      color('dim', `    ↳ run \`lmbot rules --fix\` to apply the unambiguous ones`)
    );
  }

  const query = { include_pending: false };
  if (unreviewedOnly) query.status = 'unreviewed';
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, {
    max: limit,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });

  const isBlank = (tx) => tx.category_id == null;
  const isPlaceholder = (tx) => tx.category_id != null && placeholderIds.has(tx.category_id);
  const candidates = fetched.filter(
    (tx) => !isBlank(tx) && !isPlaceholder(tx) && isEditable(tx)
  );
  const blankCount = fetched.filter(isBlank).length;
  const placeholderCount = fetched.filter(isPlaceholder).length;
  const uneditable = fetched.filter(
    (tx) => !isBlank(tx) && !isPlaceholder(tx) && !isEditable(tx)
  ).length;
  // Say where every fetched transaction went. "fetched 297, checking 120"
  // otherwise reads as if 177 were lost.
  console.log(
    `\r${color('dim', `fetched ${fetched.length} ${unreviewedOnly ? 'unreviewed ' : ''}transactions in range`)}          `
  );
  console.log(color('dim', `  ${candidates.length} with a real category to check`));
  if (blankCount || placeholderCount) {
    console.log(
      color('dim', `  ${blankCount + placeholderCount} uncategorized or in an import default`) +
        color('dim', ' — nothing to audit, that is `lmbot categorize`')
    );
  }
  if (uneditable) {
    console.log(color('dim', `  ${uneditable} split or grouped — the API can't update them`));
  }
  const reviewedCount = candidates.filter((tx) => tx.status === 'reviewed').length;
  if (unreviewedOnly) {
    console.log(color('dim', '  reviewed transactions were not fetched (--unreviewed-only)'));
  } else if (reviewedCount) {
    console.log(color('dim', `  of those, ${reviewedCount} you have already reviewed — reported, but not changed without --include-reviewed`));
  }

  if (!candidates.length) {
    console.log(color('yellow', '\nNothing categorized in range to audit.\n'));
    return;
  }

  const { suggestions } = await cascade.run(candidates, {
    llmBatchSize: num(flags['batch-size'], 25),
    onLlmProgress: (done, total) =>
      process.stdout.write(`\r${color('dim', `  llm batch ${done}/${total}…`)}`),
  });
  if (cascade.classifier?.usage.calls) process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const disagreements = candidates
    .map((tx) => ({ tx, suggestion: suggestions.get(tx.id) }))
    .filter(({ tx, suggestion }) =>
      suggestion &&
      suggestion.categoryId !== tx.category_id &&
      suggestion.confidence >= minConfidence
    );

  const agreed = candidates.filter((tx) => {
    const suggestion = suggestions.get(tx.id);
    return suggestion && suggestion.categoryId === tx.category_id;
  }).length;
  const noOpinion = candidates.filter((tx) => !suggestions.has(tx.id)).length;
  console.log(
    color('dim', `\n${agreed} agree · ${disagreements.length} disagree · ${noOpinion} no opinion`)
  );
  if (cascade.stale.length) {
    const tiers = [...new Set(cascade.stale.map((p) => p.tier))].join(', ');
    console.log(
      color('yellow', `\n${cascade.stale.length} suggestion${cascade.stale.length === 1 ? '' : 's'} named a category this account no longer has (from: ${tiers}).`)
    );
    console.log(color('dim', '  Re-run `lmbot learn` to rebuild memory against your current categories.'));
  }
  if (cascade.classifier?.usage.calls) console.log(color('dim', cascade.classifier.costNote()));

  if (!disagreements.length) {
    console.log(color('green', `\n✓ No likely miscategorizations across ${candidates.length} transactions.\n`));
    return;
  }

  // One recurring merchant produces one decision, not one row per month. Nine
  // identical Google Nest lines bury the two findings that actually differ.
  const ungrouped = bool(flags.ungrouped, false);
  const groups = new Map();
  for (const row of disagreements) {
    const key = `${payeeKey(row.tx)}|${row.tx.category_id}|${row.suggestion.categoryId}`;
    if (!groups.has(key)) groups.set(key, { ...row, count: 0, first: row.tx.date, last: row.tx.date });
    const g = groups.get(key);
    g.count++;
    if (row.tx.date < g.first) g.first = row.tx.date;
    if (row.tx.date > g.last) g.last = row.tx.date;
  }
  const shown = ungrouped
    ? disagreements.map((r) => ({ ...r, count: 1, first: r.tx.date, last: r.tx.date }))
    : [...groups.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));

  console.log('\n' + table(shown, [
    { header: 'N', right: true, get: (r) => (r.count > 1 ? `${r.count}×` : '') },
    { header: 'DATES', get: (r) => (r.count > 1 ? `${r.first} → ${r.last}` : r.first) },
    { header: 'PAYEE', get: (r) => truncate(r.tx.payee || r.tx.original_name, 26) },
    { header: 'CURRENT', get: (r) => truncate(kb.compareLabels(r.tx.category_id, r.suggestion.categoryId)[0], 24) },
    { header: 'SUGGESTED', get: (r) => truncate(kb.compareLabels(r.tx.category_id, r.suggestion.categoryId)[1], 24) },
    { header: 'VIA', get: (r) => r.suggestion.tier },
    { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
    { header: 'WHY', get: (r) => truncate(r.suggestion.reason ?? '', 30) },
  ]));
  if (!ungrouped && shown.length < disagreements.length) {
    console.log(
      color('dim', `\n${shown.length} distinct finding${shown.length === 1 ? '' : 's'} across ${disagreements.length} transactions (--ungrouped to list each)`)
    );
  }

  // When a finding list is mostly false positives, the cause is usually one
  // over-broad source rather than many bad guesses. Grouping by what produced
  // each finding makes that obvious instead of leaving it to be eyeballed.
  const bySource = new Map();
  for (const { suggestion } of disagreements) {
    const key =
      suggestion.tier === 'rule'
        ? `rule "${suggestion.name ?? suggestion.reason}"`
        : suggestion.tier;
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  if (bySource.size) {
    console.log('\n' + color('bold', 'What produced these findings'));
    for (const [source, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
      const share = n / disagreements.length;
      const flag = share >= 0.4 && n >= 3 ? color('yellow', '  ← check this one first') : '';
      console.log(`  ${String(n).padStart(3)}  ${source}${flag}`);
    }
    console.log(
      color('dim', '\nIf the current categories were right, the source above is over-matching.') +
      color('dim', '\nFor a rule: narrow its regex or drop it. For memory: your history for that') +
      color('dim', '\npayee is mixed — categorize a few consistently and re-run `lmbot learn`.')
    );
  }

  console.log(
    '\n' + color('bold', `${disagreements.length} possible miscategorization${disagreements.length === 1 ? '' : 's'} `) +
      color('dim', `out of ${candidates.length} checked`)
  );

  const writable = applyReviewed
    ? disagreements
    : disagreements.filter(({ tx }) => tx.status !== 'reviewed');
  const withheld = disagreements.length - writable.length;
  if (withheld) {
    console.log(
      color('dim', `${withheld} of those you already reviewed — add --include-reviewed to change them too`)
    );
  }

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was changed. Re-run with --apply to accept these.'));
    console.log(color('dim', 'Review this list carefully first; it overwrites categories you already have.\n'));
    return;
  }

  if (!writable.length) {
    console.log(color('yellow', '\nEverything found is already reviewed — nothing applied.'));
    console.log(color('dim', 'Add --include-reviewed if you want those changed.\n'));
    return;
  }

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(
      color('yellow', `Overwrite ${writable.length} existing categories?`)
    );
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was changed.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'audit',
    writable.map(({ tx, suggestion }) => ({
      id: tx.id,
      date: tx.date,
      payee: tx.payee,
      previous: { category_id: tx.category_id, status: tx.status },
      applied: { category_id: suggestion.categoryId, tier: suggestion.tier, reason: suggestion.reason },
    })),
    { range: range.label }
  );

  await lm.updateTransactions(
    writable.map(({ tx, suggestion }) => ({ id: tx.id, category_id: suggestion.categoryId }))
  );
  console.log(color('green', `\n✓ Recategorized ${disagreements.length} transactions.`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
