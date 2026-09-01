import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { listJournals, readJournal } from '../journal.js';
import { bool } from '../args.js';
import { color, table, truncate, confirm } from '../util.js';
import path from 'node:path';

/** Reverse a categorize/audit run using its journal. Deletions cannot be undone. */
export async function undo(flags, positional) {
  const journals = listJournals();
  if (!journals.length) {
    console.log(color('yellow', '\nNo journals found — nothing to undo.\n'));
    return;
  }

  if (bool(flags.list, false)) {
    console.log(color('bold', '\nJournals\n'));
    for (const file of journals.slice(-20)) {
      const j = readJournal(file);
      console.log(
        `  ${path.basename(file).padEnd(44)} ${color('dim', `${j.command} · ${j.entries.length} entries · ${j.range ?? ''}`)}`
      );
    }
    console.log('');
    return;
  }

  const target = positional[0]
    ? journals.find((f) => path.basename(f).includes(positional[0])) ?? positional[0]
    : journals[journals.length - 1];

  const journal = readJournal(target);
  console.log(color('bold', `\nUndo ${path.basename(target)}`));
  console.log(color('dim', `${journal.command} · ${journal.entries.length} entries · ${journal.at}`));

  if (journal.command === 'duplicates') {
    console.log(
      color('red', '\nThis journal records deletions, which the Lunch Money API cannot reverse.')
    );
    console.log(color('dim', 'The full transaction snapshots are in the journal file if you want to re-create them manually.\n'));
    return;
  }

  const reversible = journal.entries.filter((e) => e.previous);
  if (!reversible.length) {
    console.log(color('yellow', '\nNothing reversible in this journal.\n'));
    return;
  }

  const lm = new LunchMoney();
  const kb = await CategoryKB.load(lm);

  // Reverse only the fields the run actually wrote. A payee rename must not
  // touch the category, and a categorize run must not touch the payee.
  const describe = (entry, side) => {
    const state = entry[side] ?? {};
    if ('payee' in state) return state.payee || '(blank)';
    if ('category_id' in state) return kb.label(state.category_id);
    return '—';
  };

  console.log('\n' + table(reversible.slice(0, 30), [
    { header: 'DATE', get: (e) => e.date },
    { header: 'TRANSACTION', get: (e) => truncate(e.payee ?? '', 26) },
    { header: 'FROM', get: (e) => truncate(describe(e, 'applied'), 26) },
    { header: 'BACK TO', get: (e) => truncate(describe(e, 'previous'), 26) },
  ]));
  if (reversible.length > 30) console.log(color('dim', `  … and ${reversible.length - 30} more`));

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(`\nRevert ${reversible.length} transactions?`);
    if (!ok) {
      console.log(color('dim', 'Aborted.\n'));
      return;
    }
  }

  const updates = reversible.map((e) => {
    const update = { id: e.id };
    // `in` rather than a truthiness check: null is a meaningful previous value
    // (uncategorized) and must be restored, while an absent key must be left alone.
    if ('category_id' in e.previous) update.category_id = e.previous.category_id ?? null;
    if ('status' in e.previous && e.previous.status) update.status = e.previous.status;
    if ('payee' in e.previous) update.payee = e.previous.payee ?? '';
    return update;
  });

  const skipped = updates.filter((u) => Object.keys(u).length === 1);
  if (skipped.length) {
    console.log(color('yellow', `\n${skipped.length} entries had nothing recorded to restore and were skipped.`));
  }
  const actionable = updates.filter((u) => Object.keys(u).length > 1);
  if (!actionable.length) {
    console.log(color('yellow', '\nNothing to revert.\n'));
    return;
  }

  await lm.updateTransactions(actionable);
  console.log(color('green', `\n✓ Reverted ${actionable.length} transactions.\n`));
}
