import fs from 'node:fs';
import path from 'node:path';
import { JOURNAL_DIR, ensureDataDirs } from './config.js';

/**
 * Every write to Lunch Money is recorded before it happens, with the previous
 * value, so a categorize run can be reversed with `lmbot undo`.
 * Deletions are recorded too, but the API cannot undo them.
 */
export function writeJournal(command, entries, meta = {}) {
  if (!entries.length) return null;
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(JOURNAL_DIR, `${stamp}-${command}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ command, at: new Date().toISOString(), ...meta, entries }, null, 2)
  );
  return file;
}

export function listJournals() {
  ensureDataDirs();
  return fs
    .readdirSync(JOURNAL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(JOURNAL_DIR, f));
}

export function readJournal(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Transaction ids that lmbot itself categorized via the LLM tier.
 *
 * These are guesses the tool made, not decisions anyone confirmed. If `learn`
 * ingested them it would promote its own guesses into "what the user does",
 * then reproduce them at high confidence forever — the same compounding
 * failure as learning from import defaults, one step further along.
 */
export function llmWrittenIds() {
  const ids = new Set();
  for (const file of listJournals()) {
    let journal;
    try {
      journal = readJournal(file);
    } catch {
      continue;
    }
    // 'amazon' is deliberately absent: those categories were decided from the
    // order export listing what was actually bought, which is evidence rather
    // than a guess about a bank descriptor.
    if (journal.command !== 'categorize' && journal.command !== 'audit') continue;
    for (const entry of journal.entries ?? []) {
      if (entry.applied?.tier === 'llm') ids.add(entry.id);
    }
  }
  return ids;
}
