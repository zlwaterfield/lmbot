import { LunchMoney } from '../lm.js';
import { Classifier } from '../llm.js';
import { writeJournal } from '../journal.js';
import { resolveDateRange, num, bool } from '../args.js';
import { table, color, truncate, confirm } from '../util.js';
import { isEditable } from '../normalize.js';
import {
  clusterByPayee, canonicalFor, stillMessy, loadAliases, saveAliases, PAYEES_PATH,
} from '../payees.js';

/**
 * Align payee names across the variants a bank emits for one merchant.
 * Works per merchant cluster, not per transaction — you approve
 * "Starbucks" once and every variant of it moves.
 *
 * `original_name` is never modified (the API treats it as read-only), so the
 * raw descriptor is always preserved underneath a rename.
 */
export async function payees(flags) {
  const range = resolveDateRange(flags, { defaultDays: 365 });
  const limit = num(flags.limit, null);
  const apply = bool(flags.apply, false);
  const useLlm = bool(flags.llm, true);
  const minConfidence = num(flags['min-confidence'], 0.7);
  const minCount = num(flags['min-count'], 1);
  const verbose = bool(flags.verbose ?? flags.v, false);

  const lm = new LunchMoney({ verbose });

  console.log(color('bold', '\nPayee cleanup'));
  console.log(color('dim', `range: ${range.label}${limit ? ` · limit ${limit}` : ''}`));

  const aliases = loadAliases();
  if (Object.keys(aliases).length) {
    console.log(color('dim', `${Object.keys(aliases).length} saved aliases in ${PAYEES_PATH}`));
  }

  const query = { include_pending: false };
  if (range.start) {
    query.start_date = range.start;
    query.end_date = range.end;
  }

  process.stdout.write(color('dim', '\nfetching transactions… '));
  const fetched = await lm.getTransactions(query, {
    max: limit,
    onPage: (n) => process.stdout.write(`\r${color('dim', `fetching transactions… ${n}`)}`),
  });

  // Split and grouped transactions (parents and members alike) are rejected by
  // the bulk update endpoint, so they never belong in a merchant cluster.
  const usable = fetched.filter(isEditable);
  console.log(`\r${color('dim', `fetched ${fetched.length} transactions`)}            `);

  const clusters = clusterByPayee(usable, {
    mergeSimilarity: num(flags['merge-similarity'], 0.72),
  }).filter((cl) => cl.transactions.length >= minCount);
  console.log(color('dim', `${clusters.length} distinct merchants`));

  // Resolve a canonical name for each cluster from the offline tiers first.
  const decided = new Map();
  const forLlm = [];
  for (const cluster of clusters) {
    const result = canonicalFor(cluster, aliases);
    if (!result) continue;
    if (result.tier !== 'alias' && useLlm && stillMessy(result.name)) {
      forLlm.push({
        key: cluster.key,
        descriptor: cluster.transactions[0].original_name || cluster.transactions[0].payee,
        variants: [...cluster.variants.keys()],
        count: cluster.transactions.length,
      });
    }
    decided.set(cluster.key, result);
  }

  let classifier = null;
  if (forLlm.length && useLlm) {
    classifier = new Classifier({ verbose });
    const named = await classifier.namePayees(forLlm, {
      onProgress: (done, total) =>
        process.stdout.write(`\r${color('dim', `  llm batch ${done}/${total}…`)}`),
    });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    for (const [key, result] of named) {
      if (result.confidence >= minConfidence) decided.set(key, { name: result.name, tier: 'llm' });
    }
  }

  // A cluster is actionable only where some transaction's payee differs from
  // the canonical name.
  const changes = [];
  for (const cluster of clusters) {
    const target = decided.get(cluster.key);
    if (!target?.name) continue;
    const affected = cluster.transactions.filter((tx) => (tx.payee ?? '') !== target.name);
    if (!affected.length) continue;
    changes.push({
      cluster,
      target,
      affected,
      variants: [...cluster.variants.entries()].sort((a, b) => b[1] - a[1]),
    });
  }

  if (!changes.length) {
    console.log(color('green', '\n✓ Every merchant name is already consistent.\n'));
    return;
  }

  const rows = changes.map((ch) => ({
    from: ch.variants.map(([name, n]) => `${name || '(blank)'}${ch.variants.length > 1 ? ` ×${n}` : ''}`).join(' | '),
    to: ch.target.name,
    tier: ch.target.tier,
    n: ch.affected.length,
    variants: ch.variants.length,
  }));

  console.log('\n' + table(rows, [
    { header: 'CURRENT', get: (r) => truncate(r.from, 46) },
    { header: '→', get: () => '→' },
    { header: 'CLEAN NAME', get: (r) => truncate(r.to, 26) },
    { header: 'VIA', get: (r) => r.tier },
    { header: 'VARIANTS', right: true, get: (r) => r.variants },
    { header: 'TXNS', right: true, get: (r) => r.n },
  ]));

  const totalTx = changes.reduce((sum, ch) => sum + ch.affected.length, 0);
  const merged = changes.filter((ch) => ch.variants.length > 1).length;
  console.log(
    '\n' + color('bold', `${changes.length} merchants · ${totalTx} transactions`) +
      color('dim', `${merged ? ` · ${merged} with multiple spellings to merge` : ''}`)
  );
  if (classifier?.usage.calls) console.log(color('dim', classifier.costNote()));

  if (!apply) {
    console.log(color('yellow', '\nDry run — nothing was renamed. Re-run with --apply to commit.'));
    console.log(color('dim', 'The raw bank descriptor (original_name) is never modified.\n'));
    return;
  }

  if (!bool(flags.yes ?? flags.y, false) && process.stdin.isTTY) {
    const ok = await confirm(`Rename ${totalTx} transactions across ${changes.length} merchants?`);
    if (!ok) {
      console.log(color('dim', 'Aborted — nothing was renamed.\n'));
      return;
    }
  }

  const journalFile = writeJournal(
    'payees',
    changes.flatMap((ch) =>
      ch.affected.map((tx) => ({
        id: tx.id,
        date: tx.date,
        payee: tx.payee,
        previous: { payee: tx.payee },
        applied: { payee: ch.target.name, tier: ch.target.tier },
      }))
    ),
    { range: range.label }
  );

  const updates = changes.flatMap((ch) =>
    ch.affected.map((tx) => ({ id: tx.id, payee: ch.target.name }))
  );
  const results = await lm.updateTransactions(updates);
  const confirmed = results.reduce((sum, r) => sum + (r?.transactions?.length ?? 0), 0);

  // Remember every decision so the next run resolves it at the alias tier.
  for (const ch of changes) aliases[ch.cluster.key] = ch.target.name;
  saveAliases(aliases);

  console.log(color('green', `\n✓ Renamed ${confirmed || updates.length} transactions across ${changes.length} merchants.`));
  console.log(color('dim', `  ${Object.keys(aliases).length} aliases saved to ${PAYEES_PATH}`));
  if (journalFile) console.log(color('dim', `  journal: ${journalFile} (reverse with \`lmbot undo\`)\n`));
}
