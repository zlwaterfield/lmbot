import fs from 'node:fs';
import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { RuleEngine } from '../rules.js';
import { RULES_PATH } from '../config.js';
import { bool } from '../args.js';
import { color, table, truncate, confirm } from '../util.js';

/**
 * Show which rules load and which are broken, against the live category list.
 *
 * The example rules ship with generic category names ("Coffee", "Rent") that
 * almost no real account uses verbatim, so a fresh copy is mostly broken rules.
 * This says exactly which ones and what to rename them to.
 */
export async function rules(flags) {
  const lm = new LunchMoney({ verbose: bool(flags.verbose ?? flags.v, false) });
  const kb = await CategoryKB.load(lm);

  if (!fs.existsSync(RULES_PATH)) {
    console.log(color('yellow', `\nNo rules file at ${RULES_PATH}`));
    console.log(color('dim', '  cp rules.example.json data/rules.json   # then run this again\n'));
    return;
  }

  const problems = [];
  const engine = RuleEngine.load(kb, { path: RULES_PATH, warn: (msg) => problems.push(msg) });

  console.log(color('bold', '\nRules') + color('dim', `  ${RULES_PATH}`));
  console.log(color('dim', `${engine.size} loaded, ${problems.length} broken\n`));

  if (engine.size) {
    console.log(table(engine.rules, [
      { header: '', get: () => color('green', '✓') },
      { header: 'RULE', get: (r) => truncate(r.name, 26) },
      { header: 'CATEGORY', get: (r) => truncate(kb.label(r.categoryId), 30) },
      { header: 'MATCHES', get: (r) => truncate(String(r.regex).slice(0, 46), 46) },
    ]));
  }

  if (problems.length) {
    console.log('');
    for (const problem of problems) console.log(color('yellow', `✗ ${problem}`));

    if (bool(flags.fix, false)) {
      await autofix(kb);
      return;
    }
    console.log(
      color('dim', `\nRun \`lmbot rules --fix\` to apply the unambiguous suggestions, or edit`) +
      color('dim', ` ${RULES_PATH} by hand. \`lmbot categories\` lists every category.\n`)
    );
  } else if (engine.size) {
    console.log(color('green', '\n✓ Every rule resolves to a real category.\n'));
  }

  // A rule that never fires is usually a regex problem rather than a naming one,
  // and is invisible without checking it against real transactions.
  if (bool(flags.test, false) && engine.size) {
    const transactions = await lm.getTransactions(
      { include_pending: false },
      { max: 1000 }
    );
    const counts = new Map(engine.rules.map((r) => [r.name, 0]));
    for (const tx of transactions) {
      const hit = engine.match(tx);
      if (hit) counts.set(hit.name ?? hit.reason, (counts.get(hit.name ?? hit.reason) ?? 0) + 1);
    }
    console.log(color('bold', `Hits across your last ${transactions.length} transactions\n`));
    console.log(table(engine.rules, [
      { header: 'RULE', get: (r) => truncate(r.name, 26) },
      { header: 'HITS', right: true, get: (r) => counts.get(r.name) ?? 0 },
      { header: '', get: (r) => ((counts.get(r.name) ?? 0) === 0 ? color('yellow', 'never fires — check the regex') : '') },
    ]));
    console.log('');
  }
}

/**
 * Rewrite unresolvable category names in rules.json using the suggestions.
 *
 * Only rules with exactly one candidate are touched. Where two categories are
 * plausible ("Transportation" could be Uber or Transportation Other) picking
 * one silently would put real transactions in the wrong place, so those are
 * left for a human.
 */
async function autofix(kb) {
  const raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.rules ?? [];

  const changes = [];
  const ambiguous = [];
  for (const rule of list) {
    const wanted = rule.category ?? rule.category_id;
    if (wanted == null || kb.resolve(wanted) != null) continue;
    const near = kb.suggest(wanted);
    if (near.length === 1) changes.push({ rule, from: wanted, to: near[0] });
    else ambiguous.push({ rule, from: wanted, options: near });
  }

  if (!changes.length) {
    console.log(color('yellow', '\nNothing can be fixed automatically.'));
    for (const a of ambiguous) {
      console.log(
        color('dim', `  "${a.rule.name ?? a.from}" → ${a.options.length ? a.options.map((o) => JSON.stringify(o)).join(' or ') : 'no close match'}`)
      );
    }
    console.log('');
    return;
  }

  console.log(color('bold', '\nProposed changes\n'));
  for (const c of changes) {
    console.log(`  ${c.rule.name ?? '(unnamed)'}: ${color('yellow', JSON.stringify(c.from))} → ${color('green', JSON.stringify(c.to))}`);
  }
  for (const a of ambiguous) {
    console.log(
      color('dim', `  ${a.rule.name ?? '(unnamed)'}: ${JSON.stringify(a.from)} — ambiguous, left alone (${a.options.join(' | ') || 'no close match'})`)
    );
  }

  if (process.stdin.isTTY && !(await confirm(`\nRewrite ${RULES_PATH}?`))) {
    console.log(color('dim', 'Aborted — nothing was changed.\n'));
    return;
  }

  for (const c of changes) {
    c.rule.category = c.to;
    delete c.rule.category_id;
  }
  fs.writeFileSync(RULES_PATH, JSON.stringify(raw, null, 2) + '\n');
  console.log(color('green', `\n✓ Updated ${changes.length} rules.`));
  if (ambiguous.length) {
    console.log(color('yellow', `${ambiguous.length} still need a decision from you.`));
  }
  console.log(color('dim', 'Re-run `lmbot rules` to confirm.\n'));
}
