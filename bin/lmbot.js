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
  audit         Re-check already-categorized ones for mistakes ${color('dim', '(the back-run)')}
  payees        Align merchant names across bank variants     ${color('dim', '(dry run unless --apply)')}
  duplicates    Find duplicate transactions                  ${color('dim', '(dry run unless --delete)')}
  learn         Rebuild the memory tier from your history
  categories    Show the category knowledge base    ${color('dim', '(--usage for a live breakdown)')}
  undo          Reverse a previous categorize/audit run
  help          Show this message

${color('bold', 'DATE SELECTION')}   ${color('dim', '(shared by categorize, audit, duplicates, learn)')}
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
  --mark-reviewed          Also mark each categorized transaction as reviewed
  --include-reviewed       Also touch uncategorized transactions already reviewed
  --placeholder "Name"     Treat this category as uncategorized (repeatable)
  --no-placeholders        Only treat a truly empty category as uncategorized
  --batch-size 25          Transactions per LLM request

${color('bold', 'AUDIT')}
  --apply                  Overwrite the existing categories it disagrees with
  --min-confidence 0.85    Higher floor than categorize — it overwrites your work
  --include-reviewed       Audit reviewed transactions too
  --no-llm                 Rules + memory only

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

${color('bold', 'LEARN')}
  --min-count 2            Times a payee must appear before it is trusted
  --min-share 0.7          Share of those that must agree on one category
  --dry-run                Show what would be learned without saving
  --show 15                How many learned payees to print

${color('bold', 'EXAMPLES')}
  lmbot categories --usage --last-days 30    ${color('dim', '# where do unreviewed txns sit?')}
  lmbot learn --year 2025                    ${color('dim', '# teach it your habits first')}
  lmbot categorize --month 2026-08           ${color('dim', '# preview one month')}
  lmbot categorize --month 2026-08 --apply   ${color('dim', '# commit it')}
  lmbot categorize --year 2024 --include-reviewed --apply
  lmbot audit --last-days 90                 ${color('dim', '# find likely mistakes')}
  lmbot payees --year 2025                   ${color('dim', '# preview merchant renames')}
  lmbot duplicates --year 2025               ${color('dim', '# preview duplicates')}
  lmbot undo --list

${color('bold', 'GLOBAL')}
  --verbose, -v            Log every HTTP request
  --help, -h               Show this message
`;

const COMMANDS = {
  categorize: () => import('../src/commands/categorize.js').then((m) => m.categorize),
  categorise: () => import('../src/commands/categorize.js').then((m) => m.categorize),
  audit: () => import('../src/commands/audit.js').then((m) => m.audit),
  backfill: () => import('../src/commands/audit.js').then((m) => m.audit),
  payees: () => import('../src/commands/payees.js').then((m) => m.payees),
  payee: () => import('../src/commands/payees.js').then((m) => m.payees),
  duplicates: () => import('../src/commands/duplicates.js').then((m) => m.duplicates),
  dupes: () => import('../src/commands/duplicates.js').then((m) => m.duplicates),
  learn: () => import('../src/commands/learn.js').then((m) => m.learn),
  categories: () => import('../src/commands/categories.js').then((m) => m.categories),
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
