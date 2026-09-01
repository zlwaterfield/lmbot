import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { findDuplicates, findTransferPairs } from '../dupes.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool } from '../args.js';
import { color, money, truncate, confirm } from '../util.js';

const BADGE = {
  exact: (s) => color('red', s),
  likely: (s) => color('yellow', s),
  'cross-account': (s) => color('dim', s),
};

export async function duplicates(flags) {
  const range = resolveDateRange(flags, { defaultDays: 90 });
  const limit = num(flags.limit, null);
  const days = num(flags['days-apart'], 3);
  const doDelete = bool(flags.delete, false);
  const verbose = bool(flags.verbose ?? flags.v, false);
  const includeCrossAccount = bool(flags['cross-account'], false);

  const lm = new LunchMoney({ verbose });
  const kb = await CategoryKB.load(lm);

  console.log(color('bold', '\nDuplicate transaction scan'));
  console.log(color('dim', `range: ${range.label} · window ±${days} day${days === 1 ? '' : 's'}`));

  const query = { include_pending: false };
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', 'fetching transactions… '));
  const transactions = await lm.getTransactions(query, {
    max: limit,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });
  console.log(`\r${color('dim', `fetched ${transactions.length} transactions`)}            `);

  const groups = findDuplicates(transactions, { days });
  const transfers = findTransferPairs(transactions, { days });

  const actionable = groups.filter(
    (g) => g.confidence === 'exact' || g.confidence === 'likely' || (includeCrossAccount && g.confidence === 'cross-account')
  );
  const crossAccount = groups.filter((g) => g.confidence === 'cross-account');

  if (!groups.length) {
    console.log(color('green', '\n✓ No duplicates found.\n'));
    if (transfers.length) {
      console.log(color('dim', `(${transfers.length} equal-and-opposite transfer pairs seen — those are normal.)\n`));
    }
    return;
  }

  console.log('');
  for (const [i, group] of actionable.entries()) {
    const badge = (BADGE[group.confidence] ?? ((s) => s))(group.confidence.toUpperCase());
    console.log(
      `${color('bold', `[${i + 1}]`)} ${badge}  ${money(group.amount, group.currency)}  ` +
        color('dim', `${group.transactions.length} transactions`)
    );
    for (const tx of group.transactions) {
      const isKeeper = tx.id === group.keep.id;
      const marker = isKeeper ? color('green', ' keep  ') : color('red', ' DELETE');
      const meta = [
        tx.source ?? 'unknown',
        tx.status,
        tx.category_id != null ? kb.label(tx.category_id) : 'uncategorized',
      ].join(' · ');
      console.log(
        `   ${marker} ${tx.date}  ${truncate(tx.payee || tx.original_name, 30).padEnd(30)} ` +
          color('dim', `#${tx.id}  ${truncate(meta, 46)}`)
      );
    }
    console.log('');
  }

  if (crossAccount.length && !includeCrossAccount) {
    console.log(
      color('dim', `${crossAccount.length} same-amount group${crossAccount.length === 1 ? '' : 's'} spanning different accounts were excluded — `) +
        color('dim', 'these are usually transfers or a card payment. Use --cross-account to include them.\n')
    );
  }
  if (transfers.length) {
    console.log(color('dim', `${transfers.length} equal-and-opposite transfer pair${transfers.length === 1 ? '' : 's'} detected and ignored.\n`));
  }

  const toDelete = actionable.flatMap((g) => g.remove);
  console.log(
    color('bold', `${actionable.length} duplicate group${actionable.length === 1 ? '' : 's'}`) +
      color('dim', ` · ${toDelete.length} transaction${toDelete.length === 1 ? '' : 's'} proposed for deletion`)
  );

  if (!doDelete) {
    console.log(color('yellow', '\nDry run — nothing was deleted. Re-run with --delete to remove the marked ones.\n'));
    return;
  }

  if (!toDelete.length) {
    console.log(color('green', '\nNothing to delete.\n'));
    return;
  }

  console.log(color('red', '\n⚠ Deleting transactions in Lunch Money is permanent and cannot be undone.'));
  if (!bool(flags.yes ?? flags.y, false)) {
    if (!process.stdin.isTTY) {
      console.log(color('yellow', 'Refusing to delete without a TTY. Re-run with --yes if you are sure.\n'));
      return;
    }
    const ok = await confirm(color('red', `Permanently delete ${toDelete.length} transactions?`));
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was deleted.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'duplicates',
    toDelete.map((tx) => ({
      id: tx.id,
      date: tx.date,
      payee: tx.payee,
      amount: tx.amount,
      currency: tx.currency,
      deleted: true,
      snapshot: tx,
    })),
    { range: range.label, note: 'Deletions are NOT reversible; this is a record only.' }
  );

  let deleted = 0;
  const failures = [];
  for (const tx of toDelete) {
    try {
      await lm.deleteTransaction(tx.id);
      deleted++;
      process.stdout.write(`\r${color('dim', `deleting… ${deleted}/${toDelete.length}`)}`);
    } catch (err) {
      failures.push({ id: tx.id, message: err.message });
    }
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  console.log(color('green', `✓ Deleted ${deleted} transactions.`));
  if (failures.length) {
    console.log(color('yellow', `${failures.length} could not be deleted:`));
    for (const f of failures) console.log(color('dim', `  #${f.id}: ${f.message}`));
  }
  if (journalFile) console.log(color('dim', `  record: ${journalFile}\n`));
}
