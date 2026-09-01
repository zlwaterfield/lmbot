import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { Cascade } from '../classify.js';
import { isEditable } from '../normalize.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool, list } from '../args.js';
import { table, color, money, truncate, pct, confirm as ask } from '../util.js';

/**
 * Split candidates by whether an independent tier reached the same category.
 *
 *   agree     same category, confident enough  -> safe to mark reviewed
 *   weak      same category, not confident     -> left alone
 *   disagree  different category               -> left alone, that is `audit`'s job
 *   unsure    no opinion at all                -> left alone
 *
 * Every candidate lands in exactly one bucket.
 */
export function partitionByAgreement(candidates, suggestions, minConfidence) {
  const agree = [];
  const weak = [];
  const disagree = [];
  const unsure = [];

  for (const tx of candidates) {
    const suggestion = suggestions.get(tx.id);
    const row = { tx, suggestion };
    if (!suggestion) unsure.push(row);
    else if (suggestion.categoryId !== tx.category_id) disagree.push(row);
    else if (suggestion.confidence >= minConfidence) agree.push(row);
    else weak.push(row);
  }
  return { agree, weak, disagree, unsure };
}

/**
 * Clear the review queue for transactions that are already categorized correctly.
 *
 * A sync's own rules categorize plenty of things well — "TORONTO HYDRO BPY" lands
 * in Home Utility Bill without help — but every one still sits unreviewed waiting
 * for a human. `categorize` skips them (there is nothing to categorize) and
 * `audit` only surfaces disagreements. This is the third case: where an
 * independent tier reaches the same answer, that agreement is the corroboration,
 * and the transaction does not need eyes on it.
 *
 * This only ever writes `status`. A category is never changed here — a
 * disagreement is reported and left alone, because overwriting a category is
 * `audit`'s job and carries a much higher burden of proof.
 */
export async function confirmCategories(flags) {
  const range = resolveDateRange(flags, { defaultDays: 90 });
  const limit = num(flags.limit, null);
  const apply = bool(flags.apply, false);
  const useLlm = bool(flags.llm, true);
  const minConfidence = num(flags['min-confidence'], 0.8);
  const verbose = bool(flags.verbose ?? flags.v, false);

  const lm = new LunchMoney({ verbose });

  console.log(color('bold', '\nConfirm existing categories'));
  console.log(color('dim', `range: ${range.label} · agreement threshold ${pct(minConfidence)}`));

  const kb = await CategoryKB.load(lm);

  // A placeholder category is not a category anyone chose, so agreeing with it
  // would confirm nothing. Those belong to `categorize`.
  const usePlaceholders = bool(flags.placeholders, true);
  const placeholderNames = list(flags.placeholder);
  const placeholderConfig = CategoryKB.loadPlaceholderNames();
  // A name the user typed and got wrong is worth flagging; a built-in default
  // that this account simply doesn't have is not.
  const explicitNames = placeholderNames.length > 0 || placeholderConfig.explicit;
  const { ids: placeholderIds, matched } = usePlaceholders
    ? kb.resolvePlaceholders(placeholderNames.length ? placeholderNames : placeholderConfig.names)
    : { ids: new Set(), matched: [] };
  if (matched.length) console.log(color('dim', `skipping import defaults: ${matched.join(', ')}`));

  const cascade = await Cascade.create({
    kb,
    useLlm,
    minConfidence,
    verbose,
    excludeIds: placeholderIds,
    warn: (msg) => console.error(color('yellow', `  ⚠ rules.json — ${msg}`)),
  });
  if (cascade.rules.problems.length) {
    console.error(
      color('dim', `    ↳ run \`lmbot rules --fix\` to apply the unambiguous ones`)
    );
  }

  const query = { status: 'unreviewed', include_pending: false };
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, {
    max: null,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  console.log(`\r${color('dim', `fetched ${fetched.length} unreviewed transactions`)}          `);

  const eligible = fetched.filter(
    (tx) => tx.category_id != null && !placeholderIds.has(tx.category_id) && isEditable(tx)
  );
  const candidates = limit ? eligible.slice(0, limit) : eligible;
  console.log(color('dim', `${candidates.length} already categorized and awaiting review`));

  if (!candidates.length) {
    console.log(color('green', '\n✓ Nothing to confirm.\n'));
    return;
  }

  const { suggestions } = await cascade.run(candidates, {
    llmBatchSize: num(flags['batch-size'], 25),
    onLlmProgress: (done, total) =>
      process.stdout.write(`\r${color('dim', `  llm batch ${done}/${total}…`)}`),
  });
  if (cascade.classifier?.usage.calls) process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const ignoreHolds = bool(flags['ignore-holds'], false);
  const partitioned = partitionByAgreement(candidates, suggestions, minConfidence);
  const { disagree, unsure, weak } = partitioned;

  // Confirming a held merchant would defeat the point of holding it — clearing
  // the review flag is this command's entire job.
  const heldRows = ignoreHolds ? [] : partitioned.agree.filter((r) => cascade.holdsReview(r.tx));
  const agree = ignoreHolds
    ? partitioned.agree
    : partitioned.agree.filter((r) => !cascade.holdsReview(r.tx));

  if (agree.length) {
    console.log('\n' + table(agree, [
      { header: 'DATE', get: (r) => r.tx.date },
      { header: 'AMOUNT', right: true, get: (r) => money(r.tx.amount, r.tx.currency) },
      { header: 'PAYEE', get: (r) => truncate(r.tx.payee || r.tx.original_name, 32) },
      { header: 'CATEGORY (KEPT)', get: (r) => truncate(kb.label(r.tx.category_id), 26) },
      { header: 'AGREES', get: (r) => r.suggestion.tier },
      { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
    ]));
  }

  console.log(
    '\n' + color('bold', `${agree.length} of ${candidates.length} confirmed`) +
      color('dim', ' — category already correct, will be marked reviewed')
  );
  if (disagree.length) {
    console.log(
      color('yellow', `${disagree.length} disagree with their current category — left untouched.`)
    );
    console.log(color('dim', `  Run \`lmbot audit\` to review those; this command never changes a category.`));
  }
  if (heldRows.length) {
    console.log(
      color('dim', `${heldRows.length} agreed but held for your review by a never_review rule`)
    );
  }
  if (unsure.length) {
    console.log(color('dim', `${unsure.length} with no confident opinion — left for you`));
  }
  if (weak.length) {
    console.log(color('dim', `${weak.length} agreed but below the ${pct(minConfidence)} floor — left for you`));
  }
  if (cascade.classifier?.usage.calls) console.log(color('dim', cascade.classifier.costNote()));

  if (!agree.length) {
    console.log('');
    return;
  }

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was marked reviewed. Re-run with --apply to commit.\n'));
    return;
  }

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await ask(`Mark ${agree.length} transactions reviewed?`);
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was changed.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'confirm',
    agree.map(({ tx, suggestion }) => ({
      id: tx.id,
      date: tx.date,
      payee: tx.payee,
      // Only `status` is recorded, so an undo restores the review flag and
      // leaves the category exactly as it was.
      previous: { status: tx.status },
      applied: { status: 'reviewed', tier: suggestion.tier, confidence: suggestion.confidence },
    })),
    { range: range.label }
  );

  await lm.updateTransactions(agree.map(({ tx }) => ({ id: tx.id, status: 'reviewed' })));
  console.log(color('green', `\n✓ Marked ${agree.length} transactions reviewed.`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
