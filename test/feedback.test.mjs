/**
 * The memory tier must not learn from lmbot's own unverified LLM guesses.
 * Left unchecked, applying LLM suggestions and re-running `learn` promotes
 * those guesses into "what the user does" and reproduces them forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmbot-journal-'));
const { writeJournal, llmWrittenIds } = await import('../src/journal.js');
const { JOURNAL_DIR } = await import('../src/config.js');

const fail = [];

// Write a journal shaped exactly like a real categorize run.
const file = writeJournal('categorize', [
  { id: 1, date: '2026-08-01', payee: 'A', previous: { category_id: null }, applied: { category_id: 11, tier: 'llm' } },
  { id: 2, date: '2026-08-02', payee: 'B', previous: { category_id: null }, applied: { category_id: 12, tier: 'memory' } },
  { id: 3, date: '2026-08-03', payee: 'C', previous: { category_id: null }, applied: { category_id: 13, tier: 'rule' } },
]);

const ids = llmWrittenIds();
if (!ids.has(1)) fail.push('an LLM-written id must be recorded');
if (ids.has(2)) fail.push('a memory-written id must NOT be quarantined — that is real user history');
if (ids.has(3)) fail.push('a rule-written id must NOT be quarantined — the user wrote the rule');

// A payee journal must not contribute ids at all.
writeJournal('payees', [{ id: 9, date: '2026-08-04', payee: 'D', previous: { payee: 'd' }, applied: { payee: 'D', tier: 'clean' } }]);
if (llmWrittenIds().has(9)) fail.push('payee renames must not be treated as category guesses');

fs.rmSync(file, { force: true });
for (const f of fs.readdirSync(JOURNAL_DIR)) {
  if (f.includes('-payees.json')) fs.rmSync(path.join(JOURNAL_DIR, f), { force: true });
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ feedback loop: 4 assertions passed');
process.exit(fail.length ? 1 : 0);
