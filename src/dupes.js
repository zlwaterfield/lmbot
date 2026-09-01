import { normalizePayee, similarity, isEditable } from './normalize.js';

const dayMs = 86_400_000;
const daysApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / dayMs;

function accountOf(tx) {
  if (tx.plaid_account_id != null) return `plaid:${tx.plaid_account_id}`;
  if (tx.manual_account_id != null) return `manual:${tx.manual_account_id}`;
  return 'cash';
}

/**
 * A transaction that is part of a split or a group cannot be deleted through
 * the API, and a group's children are legitimately near-identical to their
 * parent — so they are excluded from duplicate detection entirely.
 */
export const isDeletable = isEditable;

/**
 * Group transactions into candidate duplicate sets.
 *
 * Confidence tiers:
 *   exact    same account, same date, same amount, same normalized payee
 *   likely   same account, within `days`, same amount, similar payee
 *   transfer same date + equal and opposite amounts across two accounts —
 *            almost always a real transfer, never a duplicate. Reported
 *            separately and never proposed for deletion.
 */
export function findDuplicates(transactions, { days = 3, payeeSimilarity = 0.6 } = {}) {
  const eligible = transactions.filter(isDeletable);

  const byAmount = new Map();
  for (const tx of eligible) {
    const key = `${String(tx.currency || 'usd').toLowerCase()}|${Number(tx.amount).toFixed(4)}`;
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(tx);
  }

  const groups = [];
  const claimed = new Set();

  for (const bucket of byAmount.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => a.date.localeCompare(b.date));

    for (const seed of sorted) {
      if (claimed.has(seed.id)) continue;
      const cluster = [seed];
      const seedKey = normalizePayee(seed.original_name || seed.payee);

      for (const other of sorted) {
        if (other.id === seed.id || claimed.has(other.id)) continue;
        if (daysApart(seed.date, other.date) > days) continue;
        const otherKey = normalizePayee(other.original_name || other.payee);
        const sim = seedKey && otherKey ? similarity(seedKey, otherKey) : 0;
        const samePayee = seedKey && seedKey === otherKey;
        if (!samePayee && sim < payeeSimilarity) continue;
        cluster.push(other);
      }

      if (cluster.length < 2) continue;
      for (const tx of cluster) claimed.add(tx.id);

      const accounts = new Set(cluster.map(accountOf));
      const dates = new Set(cluster.map((t) => t.date));
      const payees = new Set(cluster.map((t) => normalizePayee(t.original_name || t.payee)));

      let confidence;
      if (accounts.size > 1) confidence = 'cross-account';
      else if (dates.size === 1 && payees.size === 1) confidence = 'exact';
      else confidence = 'likely';

      groups.push({
        confidence,
        amount: cluster[0].amount,
        currency: cluster[0].currency,
        transactions: cluster.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id),
        ...pickKeeper(cluster),
      });
    }
  }

  return groups.sort((a, b) => a.transactions[0].date.localeCompare(b.transactions[0].date));
}

/**
 * Decide which member of a duplicate set to keep. Prefer the record with the
 * most user investment and the most authoritative source, so deleting the rest
 * loses the least information.
 */
function pickKeeper(cluster) {
  const score = (tx) => {
    let s = 0;
    if (tx.status === 'reviewed') s += 8;
    if (tx.category_id != null) s += 4;
    if (tx.notes) s += 2;
    if (tx.tag_ids?.length) s += 2;
    if (tx.source === 'plaid') s += 3;      // synced record is the bank's truth
    if (tx.source === 'manual' || tx.source === 'csv') s -= 1;
    if (tx.recurring_id) s += 1;
    return s;
  };
  const ranked = [...cluster].sort(
    (a, b) => score(b) - score(a) || String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id
  );
  return { keep: ranked[0], remove: ranked.slice(1) };
}

/** Detect equal-and-opposite pairs, which are transfers rather than duplicates. */
export function findTransferPairs(transactions, { days = 3 } = {}) {
  const pairs = [];
  const seen = new Set();
  const byAbs = new Map();
  for (const tx of transactions) {
    const key = `${String(tx.currency || 'usd').toLowerCase()}|${Math.abs(Number(tx.amount)).toFixed(4)}`;
    if (!byAbs.has(key)) byAbs.set(key, []);
    byAbs.get(key).push(tx);
  }
  for (const bucket of byAbs.values()) {
    for (const a of bucket) {
      for (const b of bucket) {
        if (a.id >= b.id || seen.has(a.id) || seen.has(b.id)) continue;
        if (Number(a.amount) + Number(b.amount) !== 0) continue;
        if (daysApart(a.date, b.date) > days) continue;
        if (accountOf(a) === accountOf(b)) continue;
        seen.add(a.id);
        seen.add(b.id);
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}
