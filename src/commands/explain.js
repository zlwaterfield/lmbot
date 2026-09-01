import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { RuleEngine } from '../rules.js';
import { Memory } from '../memory.js';
import { normalizePayee, stripLocations, similarity } from '../normalize.js';
import { num, bool } from '../args.js';
import { color, table, truncate, pct } from '../util.js';

/**
 * Answer "why didn't this one get categorized?" for a single descriptor.
 *
 * Every tier is opaque on its own: normalization is lossy, the memory key is
 * derived rather than stored, and a near-miss looks identical to a total miss
 * from the summary line. This shows the whole chain.
 */
export async function explain(flags, positional) {
  const descriptor = positional.join(' ').trim();
  if (!descriptor) {
    console.log(color('yellow', '\nUsage: lmbot explain "STARBUCKS STORE 09876 TORONTO, ON"\n'));
    return;
  }

  const memory = Memory.load();
  const rawKey = normalizePayee(descriptor);
  const key = stripLocations(rawKey, memory.stopTokens);

  console.log(color('bold', '\nExplain: ') + JSON.stringify(descriptor));
  console.log(color('dim', `normalized   ${JSON.stringify(rawKey)}`));
  if (rawKey !== key) {
    const dropped = rawKey.split(' ').filter((t) => !key.split(' ').includes(t));
    console.log(color('dim', `memory key   ${JSON.stringify(key)}  (dropped location tokens: ${dropped.join(', ')})`));
  } else {
    console.log(color('dim', `memory key   ${JSON.stringify(key)}`));
  }
  console.log(color('dim', `memory has   ${memory.size} payees, ${memory.stopTokens.size} known location tokens`));

  // Categories are only needed to print readable names.
  let kb = null;
  if (bool(flags.offline, false) === false) {
    try {
      kb = await CategoryKB.load(new LunchMoney({ verbose: false }));
    } catch (err) {
      console.log(color('dim', `(could not load categories: ${err.message})`));
    }
  }
  const label = (id) => (kb ? kb.label(id) : `#${id}`);

  // --- rules --------------------------------------------------------------
  if (kb) {
    const rules = RuleEngine.load(kb, { warn: () => {} });
    const hit = rules.match({ payee: descriptor, original_name: descriptor, amount: '0' });
    console.log('\n' + color('bold', 'rules'));
    console.log(
      hit
        ? color('green', `  ✓ ${hit.reason} → ${label(hit.categoryId)}`)
        : color('dim', `  no rule matches (${rules.size} loaded)`)
    );
  }

  // --- memory -------------------------------------------------------------
  console.log('\n' + color('bold', 'memory'));
  const exact = memory.entries[key];
  if (exact) {
    console.log(
      color('green', `  ✓ exact key match → ${label(exact.category_id)} (seen ${exact.count}/${exact.total}×)`)
    );
  } else {
    console.log(color('dim', '  no exact key match — nearest stored keys:'));
    const near = Object.entries(memory.entries)
      .map(([k, entry]) => ({ k, entry, score: similarity(key, k) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, num(flags.show, 6));

    console.log(table(near, [
      { header: '', get: (r) => (r.score >= 0.7 ? color('green', '  ✓') : '   ') },
      { header: 'SCORE', right: true, get: (r) => r.score.toFixed(2) },
      { header: 'STORED KEY', get: (r) => truncate(r.k, 36) },
      { header: 'CATEGORY', get: (r) => truncate(label(r.entry.category_id), 26) },
      { header: 'SEEN', right: true, get: (r) => `${r.entry.count}×` },
    ]));
    const best = near[0];
    if (best && best.score < 0.7) {
      console.log(
        color('dim', `  best is ${best.score.toFixed(2)}, below the 0.70 fuzzy threshold — treated as unknown`)
      );
    }
  }

  const match = memory.match({ payee: descriptor, original_name: descriptor });
  console.log(
    match
      ? color('green', `\n  memory result: ${label(match.categoryId)} at ${pct(match.confidence)}${match.fuzzy ? ' (fuzzy)' : ''}`)
      : color('yellow', '\n  memory result: no match')
  );

  console.log(color('dim', `
What to do about a miss:
  · add a rule to data/rules.json — permanent, free, and beats every other tier
  · categorize it once in Lunch Money and re-run \`lmbot learn\`
  · leave it to the LLM tier, which sees the raw descriptor rather than this key
`));
}
