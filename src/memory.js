import fs from 'node:fs';
import { MEMORY_PATH, ensureDataDirs } from './config.js';
import { payeeKey, similarity } from './normalize.js';

/**
 * Learned tier. Built from transactions the user already categorized, so it
 * encodes their actual habits rather than a generic merchant taxonomy.
 * A key is only trusted when it has been seen enough times AND one category
 * clearly dominates — a payee split evenly across two categories teaches
 * nothing and is left for the LLM.
 */
export class Memory {
  constructor(data = {}) {
    this.entries = data.entries ?? {};
    this.builtAt = data.built_at ?? null;
    this.sourceCount = data.source_count ?? 0;
  }

  static load(path = MEMORY_PATH) {
    if (!fs.existsSync(path)) return new Memory();
    try {
      return new Memory(JSON.parse(fs.readFileSync(path, 'utf8')));
    } catch {
      return new Memory();
    }
  }

  save(path = MEMORY_PATH) {
    ensureDataDirs();
    fs.writeFileSync(
      path,
      JSON.stringify(
        { built_at: this.builtAt, source_count: this.sourceCount, entries: this.entries },
        null,
        2
      )
    );
  }

  get size() {
    return Object.keys(this.entries).length;
  }

  /**
   * Rebuild from a list of already-categorized transactions.
   * `minCount` / `minShare` control how much evidence a key needs.
   */
  static build(transactions, { minCount = 2, minShare = 0.7 } = {}) {
    const tally = new Map();
    let used = 0;

    for (const tx of transactions) {
      if (tx.category_id == null) continue;
      const key = payeeKey(tx);
      if (!key || key.length < 3) continue;
      used++;
      if (!tally.has(key)) tally.set(key, { counts: new Map(), last: null, payees: new Set() });
      const entry = tally.get(key);
      entry.counts.set(tx.category_id, (entry.counts.get(tx.category_id) ?? 0) + 1);
      if (!entry.last || tx.date > entry.last) entry.last = tx.date;
      if (entry.payees.size < 3) entry.payees.add(tx.payee || tx.original_name || '');
    }

    const entries = {};
    for (const [key, entry] of tally) {
      const total = [...entry.counts.values()].reduce((a, b) => a + b, 0);
      const [categoryId, count] = [...entry.counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = count / total;
      if (count < minCount || share < minShare) continue;
      entries[key] = {
        category_id: categoryId,
        count,
        total,
        share: Number(share.toFixed(3)),
        last_seen: entry.last,
        examples: [...entry.payees],
      };
    }

    const memory = new Memory();
    memory.entries = entries;
    memory.builtAt = new Date().toISOString();
    memory.sourceCount = used;
    return memory;
  }

  /**
   * Look up a transaction. Exact key match is trusted directly; otherwise the
   * closest key above `fuzzy` wins, with confidence discounted by how close it is.
   */
  match(tx, { fuzzy = 0.75 } = {}) {
    const key = payeeKey(tx);
    if (!key) return null;

    const exact = this.entries[key];
    if (exact) {
      return {
        tier: 'memory',
        categoryId: exact.category_id,
        confidence: Math.min(0.99, 0.8 + exact.share * 0.19),
        // Confidence answers "is this the right category?". How much evidence
        // sits behind it is a separate question, and auto-review needs both —
        // a payee seen 2/2 times is as confident as one seen 50/50 but is not
        // nearly as well established.
        observations: exact.count,
        total: exact.total,
        share: exact.share,
        reason: `seen ${exact.count}/${exact.total}× as this category`,
      };
    }

    let best = null;
    for (const [candidateKey, entry] of Object.entries(this.entries)) {
      const score = similarity(key, candidateKey);
      if (score >= fuzzy && (!best || score > best.score)) best = { candidateKey, entry, score };
    }
    if (!best) return null;

    return {
      tier: 'memory',
      categoryId: best.entry.category_id,
      confidence: Math.min(0.95, best.score * best.entry.share),
      observations: best.entry.count,
      total: best.entry.total,
      share: best.entry.share,
      // A fuzzy hit matched a different payee string, so it is never treated as
      // well-established enough to auto-review however often that payee recurs.
      fuzzy: true,
      reason: `similar to "${best.candidateKey}" (${best.entry.count}×)`,
    };
  }
}
