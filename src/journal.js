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
