import { LunchMoney } from '../lm.js';
import { CategoryKB } from '../kb.js';
import { bool } from '../args.js';
import { color, table, truncate } from '../util.js';

/** Show the knowledge base — the exact category context the LLM tier receives. */
export async function categories(flags) {
  const lm = new LunchMoney({ verbose: bool(flags.verbose ?? flags.v, false) });
  const kb = await CategoryKB.load(lm);

  if (bool(flags.prompt, false)) {
    console.log(kb.toPrompt());
    return;
  }

  if (bool(flags.json, false)) {
    console.log(JSON.stringify(kb.assignable, null, 2));
    return;
  }

  const s = kb.summary();
  console.log(color('bold', '\nCategory knowledge base'));
  console.log(
    color('dim', `${s.assignable} assignable · ${s.groups} groups · ${s.income} income · ${s.archived} archived (excluded)\n`)
  );

  const rows = [...kb.assignable].sort((a, b) => kb.path(a).localeCompare(kb.path(b)));
  console.log(table(rows, [
    { header: 'ID', right: true, get: (cat) => cat.id },
    { header: 'CATEGORY', get: (cat) => truncate(kb.path(cat), 44) },
    { header: 'FLAGS', get: (cat) =>
      [cat.is_income ? 'income' : '', cat.exclude_from_budget ? 'no-budget' : '', cat.exclude_from_totals ? 'no-totals' : '']
        .filter(Boolean).join(',') },
    { header: 'DESCRIPTION', get: (cat) => truncate(cat.description ?? '', 40) },
  ]));
  console.log(color('dim', '\nUse `lmbot categories --prompt` to see exactly what the LLM tier is told.\n'));
}
