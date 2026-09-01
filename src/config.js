import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RULES_PATH = path.join(DATA_DIR, 'rules.json');
export const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');
export const JOURNAL_DIR = path.join(DATA_DIR, 'journal');

// Minimal .env loader so the project stays dependency-light.
// Real environment variables always win over the file.
function loadDotenv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenv();

export const config = {
  lmToken: process.env.LUNCH_MONEY_TOKEN || process.env.LUNCHMONEY_TOKEN || '',
  lmBaseUrl: process.env.LUNCH_MONEY_BASE_URL || 'https://api.lunchmoney.dev/v2',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
};

export function requireToken() {
  if (!config.lmToken) {
    throw new Error(
      'LUNCH_MONEY_TOKEN is not set. Copy .env.example to .env and add your token\n' +
      '(get one at https://my.lunchmoney.app/developers).'
    );
  }
  return config.lmToken;
}

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
}
