import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { Cascade } from '../classify.js';
import { isEditable } from '../normalize.js';
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
  const includeReviewed = bool(flags['include-reviewed'], false);
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
  if (!includeReviewed) query.status = 'unreviewed';
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
    `\r${color('dim', `fetched ${fetched.length} ${includeReviewed ? '' : 'unreviewed '}transactions in range`)}          `
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
  if (!includeReviewed) {
    console.log(
      color('dim', '  reviewed transactions were not fetched — add --include-reviewed to audit those too')
    );
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

  console.log('\n' + table(disagreements, [
    { header: 'DATE', get: (r) => r.tx.date },
    { header: 'AMOUNT', right: true, get: (r) => money(r.tx.amount, r.tx.currency) },
    { header: 'PAYEE', get: (r) => truncate(r.tx.payee || r.tx.original_name, 28) },
    { header: 'CURRENT', get: (r) => truncate(kb.label(r.tx.category_id), 24) },
    { header: 'SUGGESTED', get: (r) => truncate(kb.label(r.suggestion.categoryId), 24) },
    { header: 'VIA', get: (r) => r.suggestion.tier },
    { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
  ]));

  console.log(
    '\n' + color('bold', `${disagreements.length} possible miscategorization${disagreements.length === 1 ? '' : 's'} `) +
      color('dim', `out of ${candidates.length} checked`)
  );

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was changed. Re-run with --apply to accept these.'));
    console.log(color('dim', 'Review this list carefully first; it overwrites categories you already have.\n'));
    return;
  }

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(
      color('yellow', `Overwrite ${disagreements.length} existing categories?`)
    );
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was changed.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'audit',
    disagreements.map(({ tx, suggestion }) => ({
      id: tx.id,
      date: tx.date,
      payee: tx.payee,
      previous: { category_id: tx.category_id, status: tx.status },
      applied: { category_id: suggestion.categoryId, tier: suggestion.tier, reason: suggestion.reason },
    })),
    { range: range.label }
  );

  await lm.updateTransactions(
    disagreements.map(({ tx, suggestion }) => ({ id: tx.id, category_id: suggestion.categoryId }))
  );
  console.log(color('green', `\n✓ Recategorized ${disagreements.length} transactions.`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
