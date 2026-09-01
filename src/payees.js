import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDataDirs } from './config.js';
import { payeeKey, similarity } from './normalize.js';

export const PAYEES_PATH = path.join(DATA_DIR, 'payees.json');

// Processor and network prefixes that appear before the real merchant name.
const PREFIX_RE =
  /^(?:sq|tst|sp|pp|paypal|py|wl|chkcard|ckcd|pos|purchase|debit|credit|visa|mastercard|amex|ach|web|recurring|payment|pmt|dda|xfer|ext|intuit|toast|clover|stripe|sumup|venmo|zelle)\s*[*#:\-]+\s*/i;

// Words that are conventionally lowercased inside a name.
const SMALL_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'to', 'a', 'an', 'de', 'la']);

// Tokens whose casing is a brand decision, not a grammar one.
const BRAND_CASE = new Map(
  Object.entries({
    mcdonalds: "McDonald's", "mcdonald's": "McDonald's", att: 'AT&T', 'at&t': 'AT&T',
    ikea: 'IKEA', usps: 'USPS', ups: 'UPS', dmv: 'DMV', cvs: 'CVS', bp: 'BP',
    hbo: 'HBO', nyc: 'NYC', tj: 'TJ', jpmorgan: 'JPMorgan', paypal: 'PayPal',
    youtube: 'YouTube', github: 'GitHub', doordash: 'DoorDash', grubhub: 'Grubhub',
    ebay: 'eBay', iphone: 'iPhone', itunes: 'iTunes', icloud: 'iCloud', openai: 'OpenAI',
    llc: 'LLC', inc: 'Inc', usa: 'USA', us: 'US', dq: 'DQ', kfc: 'KFC', ihop: 'IHOP',
  })
);

// 'co' is deliberately absent: as a trailing token it is far more often
// "Company" than Colorado, and it is handled by the suffix strip below.
const STATES = new Set(
  ('al ak az ar ca ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh ' +
   'nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc').split(' ')
);

// Fragments left behind when a multi-word city name is stripped.
const CITY_LEAD = new Set([
  'san', 'los', 'las', 'st', 'saint', 'ft', 'fort', 'mt', 'new',
  'north', 'south', 'east', 'west', 'lake', 'port',
]);

/**
 * Turn a raw bank descriptor into a human display name.
 *
 * Deliberately less aggressive than `normalizePayee` — that one produces a lossy
 * matching key ("blue bottle"), this one produces something you want to read in
 * your ledger ("Blue Bottle"). Both are needed and they are not the same job.
 */
export function cleanPayee(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  for (let i = 0; i < 3 && PREFIX_RE.test(s); i++) s = s.replace(PREFIX_RE, '');

  s = s
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')     // 800-782-7282
    .replace(/\b1?\d{10,11}\b/g, ' ')                      // 8007827282
    .replace(/\b[A-Z0-9]*\.(?:COM|NET|ORG)\/\S*/gi, ' ')   // AMZN.COM/BILL
    .replace(/\b(?:https?:\/\/)?www\.\S+/gi, ' ')
    .replace(/#\s*\d+/g, ' ')                              // #10287
    .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, ' ')
    .replace(/\bx{2,}\d+\b/gi, ' ')                        // masked card numbers
    .replace(/[*]+/g, ' ');

  let tokens = s.split(/[\s,]+/).filter(Boolean);

  // Drop reference codes: anything containing a digit, unless it reads as part
  // of the name (a short pure number like "7" in "Store 7" is kept out too —
  // store numbers are noise far more often than they are identity).
  tokens = tokens.filter((t) => !/\d/.test(t));

  // Corporate suffixes first, so a trailing "Co" is read as Company and never
  // reaches the state check below.
  while (tokens.length > 1 && /^(inc|llc|ltd|co|corp|company)\.?$/i.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  // Trailing "CITY ST" — the state is unambiguous, the city is one more token.
  if (tokens.length > 1 && STATES.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
    if (tokens.length > 1) tokens.pop();
  }

  // ...then whatever is left of a multi-word city ("SAN" from "SAN FRANCISCO").
  while (tokens.length > 1 && CITY_LEAD.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  // A bare domain reads as a brand, not a URL: "NETFLIX.COM" -> "Netflix".
  tokens = tokens.map((t) => t.replace(/\.(?:com|net|org|io|co\.uk)$/i, ''));

  tokens = tokens.map((t) => t.replace(/^[^\w'&]+|[^\w'&.]+$/g, '')).filter(Boolean);
  if (!tokens.length) return '';

  return tokens
    .map((token, i) => {
      const lower = token.toLowerCase();
      if (BRAND_CASE.has(lower)) return BRAND_CASE.get(lower);
      // A token the user already cased deliberately (iPhone, eBay) is left alone.
      if (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))) return token;
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[\s'\-.])(\w)/g, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How presentable a payee string already is. Used to pick the best existing
 * variant in a cluster before falling back to a generated one — a name the user
 * typed themselves beats anything this file can synthesize.
 */
export function cleanliness(name) {
  if (!name) return -Infinity;
  const s = String(name);
  let score = 100;
  const letters = s.replace(/[^a-zA-Z]/g, '');

  if (/\d/.test(s)) score -= 30;
  if (/[*#]/.test(s)) score -= 25;
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(s)) score -= 20;
  // ALL CAPS is a bank-descriptor artifact rather than a name someone chose —
  // but short acronyms (IKEA, USPS, CVS) are legitimately uppercase.
  if (letters.length > 4 && letters === letters.toUpperCase()) score -= 20;
  if (letters && letters === letters.toLowerCase()) score -= 8;    // no caps at all
  if (PREFIX_RE.test(s)) score -= 20;
  if (s.length > 30) score -= (s.length - 30);
  if (s.trim().split(/\s+/).length > 5) score -= 10;
  if (!letters) score -= 60;
  return score;
}

/**
 * Group transactions by normalized merchant key, then merge keys that are near
 * variants of each other.
 *
 * The merge pass is the point of this command: exact-key clustering leaves
 * "SQ *BLUE BOTTLE 4471" and "SQ *BLUE BOTTLE COFFEE 8823" in separate buckets,
 * which is precisely the inconsistency being cleaned up. Merging is deliberately
 * conservative — "amazon" and "amazon web services" score ~0.48 and stay apart.
 */
export function clusterByPayee(transactions, { mergeSimilarity = 0.72 } = {}) {
  const exact = new Map();
  for (const tx of transactions) {
    const key = payeeKey(tx);
    if (!key) continue;
    if (!exact.has(key)) exact.set(key, { key, keys: [key], transactions: [], variants: new Map() });
    const cluster = exact.get(key);
    cluster.transactions.push(tx);
    const current = tx.payee ?? '';
    cluster.variants.set(current, (cluster.variants.get(current) ?? 0) + 1);
  }

  // Largest first, so a big well-established cluster absorbs its stragglers
  // rather than the other way round.
  const ordered = [...exact.values()].sort(
    (a, b) => b.transactions.length - a.transactions.length || a.key.localeCompare(b.key)
  );

  const merged = [];
  const taken = new Set();
  for (const cluster of ordered) {
    if (taken.has(cluster.key)) continue;
    taken.add(cluster.key);

    for (const other of ordered) {
      if (taken.has(other.key)) continue;
      if (similarity(cluster.key, other.key) < mergeSimilarity) continue;
      taken.add(other.key);
      cluster.keys.push(other.key);
      cluster.transactions.push(...other.transactions);
      for (const [name, n] of other.variants) {
        cluster.variants.set(name, (cluster.variants.get(name) ?? 0) + n);
      }
    }
    merged.push(cluster);
  }

  return merged.sort((a, b) => b.transactions.length - a.transactions.length);
}

/**
 * Decide the canonical display name for a cluster.
 * alias (you decided before) → existing (you already typed a clean one)
 * → clean (heuristic) → llm (handled by the caller).
 */
export function canonicalFor(cluster, aliases = {}) {
  // Any key in a merged cluster may carry the saved decision.
  for (const key of cluster.keys ?? [cluster.key]) {
    if (aliases[key]) return { name: aliases[key], tier: 'alias' };
  }

  const variants = [...cluster.variants.entries()];
  const best = variants
    .map(([name, count]) => ({ name, count, score: cleanliness(name) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.length - b.name.length)[0];

  // A variant that is already clean and used by more than one transaction is the
  // safest answer: it is the user's own wording.
  if (best && best.score >= 85 && (best.count > 1 || variants.length === 1)) {
    return { name: best.name, tier: 'existing' };
  }

  // Clean every spelling, then take the best result — a merged cluster's tidiest
  // variant is often not its most frequent one.
  const candidates = variants
    .map(([name, count]) => ({ name: cleanPayee(name), count }))
    .concat(cluster.transactions.slice(0, 8).map((tx) => ({ name: cleanPayee(tx.original_name), count: 0 })))
    .filter((candidate) => candidate.name)
    .sort(
      (a, b) =>
        cleanliness(b.name) - cleanliness(a.name) ||
        b.count - a.count ||
        a.name.length - b.name.length
    );
  const generated = candidates[0]?.name ?? '';

  if (generated && cleanliness(generated) > (best?.score ?? -Infinity)) {
    return { name: generated, tier: 'clean' };
  }
  if (best && best.score >= 70) return { name: best.name, tier: 'existing' };
  return generated ? { name: generated, tier: 'clean' } : null;
}

/** Is this name still messy enough to be worth an LLM call? */
export function stillMessy(name) {
  return cleanliness(name) < 80;
}

export function loadAliases(file = PAYEES_PATH) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.aliases ?? parsed ?? {};
  } catch {
    return {};
  }
}

export function saveAliases(aliases, file = PAYEES_PATH) {
  ensureDataDirs();
  fs.writeFileSync(
    file,
    JSON.stringify({ updated_at: new Date().toISOString(), aliases }, null, 2)
  );
}
