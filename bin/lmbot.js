#!/usr/bin/env node
import { parseArgs } from '../src/args.js';
import { color } from '../src/util.js';
import { LunchMoneyError } from '../src/lm.js';

const HELP = `
${color('bold', 'lmbot')} — auto-categorize Lunch Money transactions

${color('bold', 'USAGE')}
  lmbot <command> [options]

${color('bold', 'COMMANDS')}
  categorize    Categorize uncategorized transactions        ${color('dim', '(dry run unless --apply)')}
  confirm       Mark reviewed where the category is already right ${color('dim', '(dry run unless --apply)')}
  audit         Re-check already-categorized ones for mistakes ${color('dim', '(the back-run)')}
  amazon        Categorize Amazon charges from an order export ${color('dim', '(dry run unless --apply)')}
  payees        Align merchant names across bank variants     ${color('dim', '(dry run unless --apply)')}
  duplicates    Find duplicate transactions                  ${color('dim', '(dry run unless --delete)')}
  learn         Rebuild the memory tier from your history
  categories    Show the category knowledge base    ${color('dim', '(--usage for a live breakdown)')}
  rules         Check data/rules.json against your real categories
  explain       Show why one descriptor did or didn't match
  undo          Reverse a previous write
  help          Show this message

${color('bold', 'DATE SELECTION')}   ${color('dim', '(shared by categorize, confirm, audit, payees, duplicates, learn)')}
  --month 2026-08          A single calendar month
  --year 2025              A whole year
  --last-days 30           Rolling window ending today
  --start YYYY-MM-DD       Explicit start (--end defaults to today)
  --end YYYY-MM-DD         Explicit end (requires --start)
  --limit N                Cap how many transactions are processed

${color('bold', 'CATEGORIZE')}
  --apply                  Actually write to Lunch Money (default: dry run)
  --yes, -y                Skip the confirmation prompt
  --min-confidence 0.7     Confidence floor for applying a suggestion
  --no-llm                 Rules + memory only, no API calls to Anthropic
  --mark-reviewed          Mark every categorized transaction as reviewed
  --auto-review            Mark reviewed only where the evidence earns it
  --auto-review-min 0.9      confidence floor for auto-review
  --auto-review-observations 3   times memory must have seen the payee
  --auto-review-llm          let LLM suggestions auto-review too (off)
  --include-reviewed       Also touch uncategorized transactions already reviewed
  --ignore-holds           Ignore never_review rules for this run
  --placeholder "Name"     Treat this category as uncategorized (repeatable)
  --no-placeholders        Only treat a truly empty category as uncategorized
  --batch-size 25          Transactions per LLM request

${color('bold', 'CONFIRM')}
  --apply                  Actually mark reviewed (default: dry run)
  --yes, -y                Skip the confirmation prompt
  --min-confidence 0.8     Agreement needed to clear the review flag
  --ignore-holds           Ignore never_review rules for this run
  --no-llm                 Rules + memory only
  ${color('dim', 'Never changes a category — only the review flag.')}

${color('bold', 'AUDIT')}   ${color('dim', 'reports on everything; only writes to unreviewed by default')}
  --apply                  Overwrite the existing categories it disagrees with
  --min-confidence 0.85    Higher floor than categorize — it overwrites your work
  --include-reviewed       Also CHANGE transactions you already reviewed
  --unreviewed-only        Don't even look at reviewed ones (smaller, cheaper run)
  --ungrouped              List every transaction instead of one row per merchant
  --no-llm                 Rules + memory only

${color('bold', 'AMAZON')}   ${color('dim', 'lmbot amazon <order-history.csv>')}
  --apply                  Actually write to Lunch Money (default: dry run)
  --auto-review            Also mark reviewed where confidence is high
  --min-confidence 0.8     Floor for applying, and for auto-review
  --days-apart 7           How far a charge may sit from its order date
  --match "<regex>"        Override how Amazon transactions are recognised
  ${color('dim', 'Only order-matched charges are touched; unmatched ones are left alone.')}

${color('bold', 'PAYEES')}
  --apply                  Actually rename in Lunch Money (default: dry run)
  --yes, -y                Skip the confirmation prompt
  --min-count 1            Only merchants seen at least this many times
  --min-confidence 0.7     Confidence floor for an LLM-proposed name
  --no-llm                 Aliases + heuristic cleanup only

${color('bold', 'DUPLICATES')}
  --delete                 Permanently delete the marked duplicates
  --yes, -y                Skip the confirmation prompt
  --days-apart 3           How far apart two transactions can be and still match
  --cross-account          Also flag same-amount matches across different accounts

${color('bold', 'RULES')}
  --fix                    Rewrite unambiguous category names in rules.json
  --test                   Show how many transactions each rule actually matches
  --yes, -y                Skip the confirmation prompt

${color('bold', 'LEARN')}
  --reviewed-only          Learn only from transactions you have reviewed
  --placeholder "Name"     Don't learn from this category unless reviewed
  --no-placeholders        Learn from every categorized transaction
  --no-skip-own-guesses    Also learn from lmbot's own unreviewed LLM writes
  --min-count 2            Times a payee must appear before it is trusted
  --min-share 0.7          Share of those that must agree on one category
  --dry-run                Show what would be learned without saving
  --show 15                How many learned payees to print

${color('bold', 'EXAMPLES')}
  lmbot categories --usage --last-days 30    ${color('dim', '# where do unreviewed txns sit?')}
  lmbot learn --year 2025                    ${color('dim', '# teach it your habits first')}
  lmbot categorize --month 2026-08           ${color('dim', '# preview one month')}
  lmbot categorize --month 2026-08 --apply   ${color('dim', '# commit it')}
  lmbot categorize --last-days 30 --auto-review --apply
  lmbot categorize --year 2024 --include-reviewed --apply
  lmbot confirm --last-days 30               ${color('dim', '# clear the review queue')}
  lmbot audit --last-days 90                 ${color('dim', '# find likely mistakes')}
  lmbot amazon ~/Downloads/Order\\ History.csv --year 2026
  lmbot payees --year 2025                   ${color('dim', '# preview merchant renames')}
  lmbot duplicates --year 2025               ${color('dim', '# preview duplicates')}
  lmbot rules --test                         ${color('dim', '# which rules work, which never fire')}
  lmbot explain "WOOF GANG LESLIEVILLE TORONTO"
  lmbot undo --list

${color('bold', 'GLOBAL')}
  --verbose, -v            Log every HTTP request
  --help, -h               Show this message
`;

const COMMANDS = {
  categorize: () => import('../src/commands/categorize.js').then((m) => m.categorize),
  categorise: () => import('../src/commands/categorize.js').then((m) => m.categorize),
  confirm: () => import('../src/commands/confirm.js').then((m) => m.confirmCategories),
  audit: () => import('../src/commands/audit.js').then((m) => m.audit),
  backfill: () => import('../src/commands/audit.js').then((m) => m.audit),
  amazon: () => import('../src/commands/amazon.js').then((m) => m.amazon),
  payees: () => import('../src/commands/payees.js').then((m) => m.payees),
  payee: () => import('../src/commands/payees.js').then((m) => m.payees),
  duplicates: () => import('../src/commands/duplicates.js').then((m) => m.duplicates),
  dupes: () => import('../src/commands/duplicates.js').then((m) => m.duplicates),
  learn: () => import('../src/commands/learn.js').then((m) => m.learn),
  categories: () => import('../src/commands/categories.js').then((m) => m.categories),
  rules: () => import('../src/commands/rules.js').then((m) => m.rules),
  explain: () => import('../src/commands/explain.js').then((m) => m.explain),
  undo: () => import('../src/commands/undo.js').then((m) => m.undo),
};

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  if (!command || command === 'help' || flags.help || flags.h) {
    console.log(HELP);
    return;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(color('red', `Unknown command "${command}".`));
    console.error(color('dim', `Try one of: ${Object.keys(COMMANDS).join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const run = await loader();
  await run(flags, positional);
}

main().catch((err) => {
  if (err instanceof LunchMoneyError) {
    console.error(color('red', `\nLunch Money API error: ${err.message}\n`));
  } else {
    console.error(color('red', `\n${err.message}\n`));
    if (process.env.LMBOT_DEBUG) console.error(err.stack);
  }
  process.exitCode = 1;
});
