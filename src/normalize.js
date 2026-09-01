/**
 * Payee normalization. Bank descriptors are noisy — the same merchant shows up
 * as "SQ *BLUE BOTTLE 4471", "BLUE BOTTLE COFFEE #12 OAKLAND CA", "TST* BLUE
 * BOTTLE". Collapsing them to a stable key is what makes the memory tier work.
 */

// Payment-processor and network prefixes that carry no merchant information.
const PREFIXES = [
  'sq', 'tst', 'sp', 'pp', 'paypal', 'py', 'wl', 'chkcard', 'ckcd', 'pos',
  'purchase', 'debit', 'credit', 'visa', 'mastercard', 'amex', 'ach', 'web',
  'recurring', 'payment', 'pmt', 'dda', 'xfer', 'transfer', 'ext', 'intuit',
  'toast', 'clover', 'stripe', 'sumup', 'venmo', 'zelle',
];

const NOISE_WORDS = new Set([
  'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'store', 'stores',
  'usa', 'us', 'online', 'com', 'www', 'http', 'https',
]);

// Two-letter US state codes, stripped when they trail the descriptor.
const STATES = new Set(
  ('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo ' +
   'mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc')
    .split(' ')
);

export function normalizePayee(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase();

  // Strip processor prefixes like "sq *", "tst*", "paypal *"
  const prefixRe = new RegExp(`^(?:${PREFIXES.join('|')})\\s*[*#:\\-]+\\s*`, 'i');
  for (let i = 0; i < 3 && prefixRe.test(s); i++) s = s.replace(prefixRe, '');

  s = s
    .replace(/[*#]/g, ' ')                       // separators
    .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, ' ') // dates
    .replace(/\bx{2,}\d+\b/g, ' ')               // masked card numbers
    .replace(/\b\d{4,}\b/g, ' ')                 // long numbers (store/ref ids)
    .replace(/\b[a-z]*\d+[a-z\d]*\b/g, ' ')      // alphanumeric ref codes
    .replace(/[^a-z\s]/g, ' ')                   // punctuation
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = s.split(' ').filter(Boolean);

  // Trailing "CITY ST" — drop the state and, if present, keep the city out of
  // the key only when there is enough merchant name left to be distinctive.
  if (tokens.length > 2 && STATES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
    if (tokens.length > 2) tokens = tokens.slice(0, -1);
  }

  // Leftover city-lead fragments after the city name was stripped ("... SAN")
  const CITY_LEAD = new Set(['san', 'los', 'las', 'st', 'saint', 'ft', 'fort', 'mt', 'new', 'north', 'south', 'east', 'west']);
  while (tokens.length > 1 && CITY_LEAD.has(tokens[tokens.length - 1])) tokens.pop();

  tokens = tokens.filter((t) => t.length > 1 && !NOISE_WORDS.has(t));

  // Keep the first 4 meaningful tokens — enough to identify a merchant without
  // letting per-transaction junk fragment the key.
  return tokens.slice(0, 4).join(' ');
}

/** Best normalized key for a transaction: prefer the raw bank descriptor. */
export function payeeKey(tx) {
  return normalizePayee(tx.original_name || tx.payee) || normalizePayee(tx.payee) || '';
}

/** Token-set (Jaccard) similarity — robust to word order and extra tokens. */
function tokenSimilarity(a, b) {
  const ta = new Set(String(a || '').split(' ').filter(Boolean));
  const tb = new Set(String(b || '').split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Character-bigram (Dice) similarity on the de-spaced string. Catches the
 * abbreviations and concatenations that token matching misses entirely —
 * "WHOLEFOODS MKT" vs "WHOLE FOODS MARKET" share no tokens but most bigrams.
 */
function charSimilarity(a, b) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const sa = norm(a);
  const sb = norm(b);
  // Too short to be meaningful — two 4-char strings collide by chance.
  if (sa.length < 5 || sb.length < 5) return 0;

  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = bigrams(sa);
  const gb = bigrams(sb);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  const total = sa.length - 1 + (sb.length - 1);
  return total > 0 ? (2 * shared) / total : 0;
}

/**
 * Merchant similarity, used by duplicate detection and the memory tier's fuzzy
 * lookup. Takes the better of the two measures: they fail on opposite inputs,
 * so a merchant only has to be recognizable by one of them.
 */
export function similarity(a, b) {
  return Math.max(tokenSimilarity(a, b), charSimilarity(a, b));
}

/**
 * Transactions that were split or grouped cannot be modified or deleted through
 * the bulk endpoints — the API rejects them and points you at /transactions/split
 * or /transactions/group instead. Both parents and members are affected.
 */
export function isEditable(tx) {
  return !(
    tx.is_split_parent ||
    tx.split_parent_id != null ||
    tx.is_group_parent ||
    tx.group_parent_id != null
  );
}
