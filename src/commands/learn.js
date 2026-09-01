import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { Memory } from '../memory.js';
import { llmWrittenIds } from '../journal.js';
import { MEMORY_PATH } from '../config.js';
import { resolveDateRange, num, bool, list } from '../args.js';
import { table, color, truncate } from '../util.js';

/**
 * Build the memory tier from transactions the user has already categorized.
 * This is what makes the cascade personal rather than generic.
 */
export async function learn(flags) {
  const range = resolveDateRange(flags, { defaultDays: 730 });
  const minCount = num(flags['min-count'], 2);
  const minShare = num(flags['min-share'], 0.7);
  const verbose = bool(flags.verbose ?? flags.v, false);

  const lm = new LunchMoney({ verbose });
  const kb = await CategoryKB.load(lm);

  console.log(color('bold', '\nLearning from your categorization history'));
  console.log(color('dim', `range: ${range.label}`));

  const query = { include_pending: false };
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', 'fetching transactions… '));
  const transactions = await lm.getTransactions(query, {
    max: num(flags.limit, null),
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  // A transaction a sync dropped into an import-default category and nobody
  // ever looked at is not evidence of anything. Learning from it would teach
  // the memory tier that the placeholder IS the right answer, and every later
  // run would confidently reproduce it. Reviewing one makes it real signal
  // again — that is the user accepting the category.
  const usePlaceholders = bool(flags.placeholders, true);
  const placeholderNames = list(flags.placeholder);
  const { ids: placeholderIds, matched, unmatched } = usePlaceholders
    ? kb.resolvePlaceholders(placeholderNames.length ? placeholderNames : CategoryKB.loadPlaceholderNames())
    : { ids: new Set(), matched: [], unmatched: [] };

  if (matched.length) console.log(color('dim', `ignoring unreviewed: ${matched.join(', ')}`));
  if (unmatched.length) {
    console.log(color('yellow', `  ⚠ no category named ${unmatched.map((n) => JSON.stringify(n)).join(', ')} — ignored`));
  }

  const reviewedOnly = bool(flags['reviewed-only'], false);
  const guessed = bool(flags['skip-own-guesses'], true) ? llmWrittenIds() : new Set();

  const isUnreviewedPlaceholder = (tx) =>
    placeholderIds.has(tx.category_id) && tx.status !== 'reviewed';
  // A category lmbot's own LLM tier wrote is only trustworthy once a human has
  // reviewed it. Until then it is this tool's guess, not the user's habit.
  const isOwnUnverifiedGuess = (tx) => guessed.has(tx.id) && tx.status !== 'reviewed';

  const withCategory = transactions.filter((tx) => tx.category_id != null);
  const reject = (tx) =>
    isUnreviewedPlaceholder(tx) ||
    isOwnUnverifiedGuess(tx) ||
    (reviewedOnly && tx.status !== 'reviewed');

  const ignored = withCategory.filter(reject);
  const categorized = withCategory.filter((tx) => !reject(tx));
  const skippedPlaceholder = withCategory.filter(isUnreviewedPlaceholder).length;
  const skippedGuess = withCategory.filter((tx) => !isUnreviewedPlaceholder(tx) && isOwnUnverifiedGuess(tx)).length;
  console.log(`\r${color('dim', `fetched ${transactions.length} transactions, ${categorized.length} usable`)}          `);
  if (skippedPlaceholder) {
    console.log(
      color('yellow', `  ${skippedPlaceholder} skipped: in an import-default category and never reviewed`)
    );
  }
  if (skippedGuess) {
    console.log(
      color('yellow', `  ${skippedGuess} skipped: lmbot's own LLM guesses, not yet reviewed by you`)
    );
  }
  if (reviewedOnly) {
    const other = ignored.length - skippedPlaceholder - skippedGuess;
    if (other > 0) console.log(color('yellow', `  ${other} skipped: not reviewed (--reviewed-only)`));
  }

  if (!categorized.length) {
    console.log(color('yellow', '\nNo categorized transactions in range — nothing to learn from.\n'));
    return;
  }

  const memory = Memory.build(categorized, { minCount, minShare });
  const previous = Memory.load();

  console.log(
    color('bold', `\n${memory.size} payees learned `) +
      color('dim', `(from ${memory.sourceCount} transactions, ≥${minCount}× and ≥${Math.round(minShare * 100)}% agreement)`)
  );

  const top = Object.entries(memory.entries)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, num(flags.show, 15));
  console.log('\n' + table(top, [
    { header: 'PAYEE KEY', get: ([key]) => truncate(key, 28) },
    { header: 'CATEGORY', get: ([, e]) => truncate(kb.label(e.category_id), 28) },
    { header: 'SEEN', right: true, get: ([, e]) => `${e.count}/${e.total}` },
    { header: 'EXAMPLE', get: ([, e]) => truncate(e.examples[0] ?? '', 30) },
  ]));
  if (Object.keys(memory.entries).length > top.length) {
    console.log(color('dim', `  … and ${Object.keys(memory.entries).length - top.length} more`));
  }

  if (bool(flags['dry-run'], false)) {
    console.log(color('yellow', '\nDry run — memory not saved.\n'));
    return;
  }

  memory.save();
  const delta = memory.size - previous.size;
  console.log(color('green', `\n✓ Saved to ${MEMORY_PATH}`));
  console.log(color('dim', `  ${previous.size} → ${memory.size} payees (${delta >= 0 ? '+' : ''}${delta})\n`));
}
