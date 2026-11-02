import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { RuleEngine } from '../rules.js';
import { Classifier } from '../llm.js';
import { isEditable } from '../normalize.js';
import { writeJournal } from '../journal.js';
import { loadOrders, matchTransaction, describeItems, noteFor, nextNote, NOTE_PREFIX } from '../amazon.js';
import { resolveDateRange, num, bool, list } from '../args.js';
import { table, color, money, truncate, pct, confirm } from '../util.js';

const DEFAULT_MATCH = '\\b(amazon|amzn)\\b';

/**
 * Categorize Amazon charges using the order history export.
 *
 * "AMZN Mktp CA" is opaque by design — the same descriptor covers vitamins, a
 * bike bottle and a book, so no rule or learned payee can ever categorize it.
 * That is why Amazon is usually held back for manual review. Joining the bank
 * charge to the order export replaces the guess with the actual product names,
 * which is enough to decide, and enough to justify clearing the review flag.
 *
 * Only order-matched transactions may auto-review. An unmatched Amazon charge
 * is exactly as opaque as before and is left alone.
 *
 * Every charge the export can speak to also gets a note listing what was
 * bought — including the ones below the confidence floor, which are exactly
 * the ones left for a human, and ambiguous ones, which list each candidate.
 * `--notes-only` backfills those notes without deciding anything.
 */
export async function amazon(flags, positional) {
  const csvPath = positional[0] ?? flags.csv;
  if (!csvPath || csvPath === true) {
    console.log(color('yellow', '\nUsage: lmbot amazon <path-to-order-history.csv> [--year 2026]'));
    console.log(color('dim', '  Download it from Amazon → Account → Request My Data → Your Orders.\n'));
    return;
  }

  const range = resolveDateRange(flags, { defaultDays: 365 });
  const apply = bool(flags.apply, false);
  const autoReview = bool(flags['auto-review'], false);
  const notesOnly = bool(flags['notes-only'], false);
  const writeNotes = bool(flags.notes, true);
  const minConfidence = num(flags['min-confidence'], 0.8);
  const windowDays = num(flags['days-apart'], 7);
  const limit = num(flags.limit, null);
  const verbose = bool(flags.verbose ?? flags.v, false);
  const matcher = new RegExp(list(flags.match)[0] ?? DEFAULT_MATCH, 'i');

  console.log(color('bold', notesOnly ? '\nAmazon orders → notes' : '\nAmazon orders → categories'));
  console.log(color('dim', `range: ${range.label} · match window ±${windowDays} days`));

  const { orders, cancelled } = loadOrders(csvPath);
  console.log(color('dim', `${orders.length} orders loaded${cancelled ? `, ${cancelled} cancelled ignored` : ''}`));

  const lm = new LunchMoney({ verbose });
  const kb = await CategoryKB.load(lm);
  const placeholderConfig = CategoryKB.loadPlaceholderNames();
  const { ids: placeholderIds } = kb.resolvePlaceholders(placeholderConfig.names);

  // A note decides nothing, so backfilling one onto a reviewed charge is safe.
  // Categorizing still only ever touches unreviewed ones.
  const query = { include_pending: false };
  if (!notesOnly) query.status = 'unreviewed';
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }
  const scope = notesOnly ? '' : ' unreviewed';

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, {
    max: null,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  const amazonTx = fetched.filter(
    (tx) => isEditable(tx) && matcher.test(`${tx.payee ?? ''} ${tx.original_name ?? ''}`)
  );
  console.log(`\r${color('dim', `fetched ${fetched.length}${scope}, ${amazonTx.length} look like Amazon`)}       `);

  if (!amazonTx.length) {
    console.log(color('green', `\n✓ No${scope} Amazon transactions in range.\n`));
    return;
  }

  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  for (const tx of amazonTx.slice(0, limit ?? amazonTx.length)) {
    const match = matchTransaction(tx, orders, { days: windowDays });
    if (match?.order) matched.push({ tx, match });
    else if (match?.ambiguous) ambiguous.push({ tx, match });
    else unmatched.push({ tx });
  }

  console.log(color('dim', `  ${matched.length} matched to an order`));
  if (ambiguous.length) {
    const fate = notesOnly ? 'noted with each candidate' : writeNotes ? 'not categorized, noted with each candidate' : 'skipped';
    console.log(color('dim', `  ${ambiguous.length} matched several orders at the same amount — ${fate}`));
  }
  if (unmatched.length) {
    console.log(color('dim', `  ${unmatched.length} with no matching order — left alone (refunds, gift cards, or orders outside the export)`));
  }

  const notes = new Map();
  let keptYours = 0;
  if (writeNotes) {
    for (const { tx, match } of [...matched, ...ambiguous]) {
      const note = nextNote(tx.notes, match);
      if (note) notes.set(tx.id, note);
      else if (tx.notes && !tx.notes.startsWith(NOTE_PREFIX) && noteFor(match)) keptYours++;
    }
  }

  if (!matched.length && !notes.size) {
    console.log(color('yellow', '\nNothing to categorize.\n'));
    return;
  }

  let rows = [];
  if (!notesOnly && matched.length) {
    const classifier = new Classifier({ kb, verbose, excludeIds: placeholderIds });
    const enriched = matched.map(({ tx, match }) => ({
      ...tx,
      items: describeItems(match),
    }));

    const suggestions = await classifier.classify(enriched, {
      batchSize: num(flags['batch-size'], 20),
      onProgress: (done, total) =>
        process.stdout.write(`\r${color('dim', `  llm batch ${done}/${total}…`)}`),
    });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    rows = matched
      .map(({ tx, match }) => ({ tx, match, suggestion: suggestions.get(tx.id) }))
      // The floor gates applying, not just auto-review: an order that spans
      // categories gets a low score, and guessing one is worse than leaving it.
      .filter((r) => r.suggestion && r.suggestion.confidence >= minConfidence)
      .map((r) => ({
        ...r,
        changed: r.suggestion.categoryId !== r.tx.category_id,
        review: autoReview,
      }));

    const lowConfidence = matched.length - rows.length;

    if (rows.length) {
      console.log('\n' + table(rows, [
        { header: 'DATE', get: (r) => r.tx.date },
        { header: 'AMOUNT', right: true, get: (r) => money(r.tx.amount, r.tx.currency) },
        { header: 'BOUGHT', get: (r) => truncate(describeItems(r.match), 46) },
        { header: 'CURRENT', get: (r) => (r.tx.category_id == null ? '—' : truncate(kb.compareLabels(r.tx.category_id, r.suggestion.categoryId)[0], 18)) },
        { header: 'CATEGORY', get: (r) => truncate(kb.compareLabels(r.tx.category_id ?? -1, r.suggestion.categoryId)[1], 22) },
        { header: 'CONF', right: true, get: (r) => pct(r.suggestion.confidence) },
        { header: 'REVIEWED', get: (r) => (r.review ? 'yes' : '') },
      ]));

      const willReview = rows.filter((r) => r.review).length;
      const willChange = rows.filter((r) => r.changed).length;
      console.log(
        '\n' + color('bold', `${rows.length} of ${matched.length} categorized from their order contents`)
      );
      console.log(color('dim', `${willChange} category changes · ${willReview} will be marked reviewed`));
      if (!autoReview) {
        console.log(
          color('dim', 'Add --auto-review to clear the review flag on the confident ones.')
        );
      } else if (willReview) {
        // A never_review hold on Amazon exists because the descriptor is opaque.
        // Having the order contents removes that reason, so this command overrides
        // the hold — but silently overriding a standing instruction would be wrong.
        const rules = RuleEngine.load(kb, { warn: () => {} });
        const heldBy = rows.map((r) => rules.holdsReview(r.tx)).find(Boolean);
        if (heldBy) {
          console.log(
            color('yellow', `Note: "${heldBy}" normally holds these back from auto-review.`)
          );
          console.log(
            color('dim', '  Overridden here because the order export says what was actually bought.')
          );
        }
      }
    } else {
      console.log(color('yellow', `\nNo confident suggestions for ${matched.length} matched transactions.`));
    }
    if (lowConfidence) {
      console.log(color('dim', `${lowConfidence} matched but below the ${pct(minConfidence)} floor — left for you`));
    }
    console.log(color('dim', classifier.costNote()));
  }

  if (notesOnly && notes.size) {
    const noted = [...matched, ...ambiguous].filter(({ tx }) => notes.has(tx.id));
    console.log('\n' + table(noted, [
      { header: 'DATE', get: ({ tx }) => tx.date },
      { header: 'AMOUNT', right: true, get: ({ tx }) => money(tx.amount, tx.currency) },
      { header: 'STATUS', get: ({ tx }) => tx.status },
      { header: 'NOTE', get: ({ tx }) => truncate(notes.get(tx.id).slice(NOTE_PREFIX.length), 70) },
    ]));
  }
  if (writeNotes) {
    console.log(
      color('dim', `${notes.size} notes saying what was bought${keptYours ? ` · ${keptYours} already have a note of yours — left alone` : ''}`)
    );
  }

  if (!rows.length && !notes.size) {
    console.log(color('green', '\n✓ Nothing to write.\n'));
    return;
  }

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was written. Re-run with --apply to commit.\n'));
    return;
  }

  const willReview = rows.filter((r) => r.review).length;
  const parts = [
    rows.length && `${rows.length} categories`,
    willReview && `review ${willReview}`,
    notes.size && `${notes.size} notes`,
  ].filter(Boolean);

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(`Apply ${parts.join(', ')}?`);
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was written.\n'));
      return;
    }
  }

  const txById = new Map([...matched, ...ambiguous].map(({ tx }) => [tx.id, tx]));
  const rowById = new Map(rows.map((r) => [r.tx.id, r]));
  const ids = [...new Set([...rowById.keys(), ...notes.keys()])];

  const journalFile = writeJournal(
    'amazon',
    ids.map((id) => {
      const tx = txById.get(id);
      const row = rowById.get(id);
      const previous = {};
      const applied = {};
      if (row) {
        previous.category_id = tx.category_id;
        previous.status = tx.status;
        applied.category_id = row.suggestion.categoryId;
        // Recorded as its own tier: this decision was made from the order
        // export, not from the model guessing at a bank descriptor, so `learn`
        // should not quarantine it the way it quarantines a bare LLM guess.
        applied.tier = 'amazon';
        applied.status = row.review ? 'reviewed' : undefined;
        applied.reason = row.suggestion.reason;
      }
      if (notes.has(id)) {
        previous.notes = tx.notes ?? null;
        applied.notes = notes.get(id);
      }
      return { id, date: tx.date, payee: tx.payee, previous, applied };
    }),
    { range: range.label, csv: csvPath }
  );

  await lm.updateTransactions(
    ids.map((id) => {
      const row = rowById.get(id);
      const update = { id };
      if (row) {
        update.category_id = row.suggestion.categoryId;
        if (row.review) update.status = 'reviewed';
      }
      if (notes.has(id)) update.notes = notes.get(id);
      return update;
    })
  );

  const done = [
    rows.length && `${rows.length} categorized`,
    willReview && `${willReview} marked reviewed`,
    notes.size && `${notes.size} noted`,
  ].filter(Boolean);
  console.log(color('green', `\n✓ Updated ${ids.length} transactions (${done.join(', ')}).`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
