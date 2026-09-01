import fs from 'node:fs';
import { RULES_PATH } from './config.js';

/**
 * Deterministic tier. Regex over the payee / bank descriptor, optionally gated
 * on amount, sign, or account. First matching rule wins, so order matters.
 */
/**
 * Catch the JSON escaping trap before it becomes a rule that never fires.
 *
 * In JSON, "\b" is a backspace character, not a regex word boundary — that
 * needs "\\b". A rule written with single backslashes parses fine, compiles
 * fine, and silently matches nothing, which is the worst possible failure for
 * something that quietly hands work to a paid tier instead.
 */
const CONTROL_ESCAPES = { '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function escapingProblem(pattern) {
  const found = [...new Set([...String(pattern)].filter((ch) => ch.charCodeAt(0) < 32))];
  if (!found.length) return null;
  const shown = found.map((ch) => CONTROL_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return (
    `pattern contains a literal control character (${shown.join(', ')}) — ` +
    'in JSON a regex backslash must be doubled, so write "\\\\b" not "\\b"'
  );
}

export class RuleEngine {
  constructor(rules, kb, { warn = () => {}, neverReview = [] } = {}) {
    this.kb = kb;
    this.rules = [];
    this.problems = [];

    /**
     * Merchants that must never be marked reviewed automatically, whichever
     * tier categorized them. A per-rule `review: false` only applies when that
     * rule fires, so it cannot cover a merchant the memory tier or the LLM
     * handles — or one `confirm` agrees with. This is checked against the
     * transaction itself, so it holds everywhere.
     */
    this.holds = [];
    neverReview.forEach((hold, i) => {
      const label = hold.name || `never_review #${i + 1}`;
      const bad = escapingProblem(hold.match);
      if (bad) {
        this.problems.push(`${label}: ${bad}`);
        return;
      }
      try {
        this.holds.push({
          name: label,
          regex: new RegExp(hold.match, hold.flags ?? 'i'),
          fields: hold.fields ?? ['payee', 'original_name', 'notes'],
        });
      } catch (err) {
        this.problems.push(`${label}: bad regex — ${err.message}`);
      }
    });

    rules.forEach((rule, i) => {
      const label = rule.name || `rule #${i + 1}`;
      const wanted = rule.category ?? rule.category_id;
      const categoryId = kb.resolve(wanted);
      if (categoryId == null) {
        const near = kb.suggest(wanted);
        this.problems.push(
          `${label}: no category named ${JSON.stringify(wanted)}` +
            (near.length ? ` — did you mean ${near.map((n) => JSON.stringify(n)).join(' or ')}?` : '')
        );
        return;
      }
      const escaping = escapingProblem(rule.match);
      if (escaping) {
        this.problems.push(`${label}: ${escaping}`);
        return;
      }
      let regex;
      try {
        regex = new RegExp(rule.match, rule.flags ?? 'i');
      } catch (err) {
        this.problems.push(`${label}: bad regex — ${err.message}`);
        return;
      }
      this.rules.push({
        name: label,
        regex,
        categoryId,
        fields: rule.fields ?? ['payee', 'original_name', 'notes'],
        amountMin: rule.amount_min ?? null,
        amountMax: rule.amount_max ?? null,
        sign: rule.sign ?? null,               // 'debit' | 'credit'
        accountIds: rule.account_ids ?? null,
        notes: rule.notes ?? null,
        review: rule.review ?? null,
      });
    });

    for (const p of this.problems) warn(p);
  }

  static load(kb, { path = RULES_PATH, warn } = {}) {
    if (!fs.existsSync(path)) return new RuleEngine([], kb, { warn });
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${path}: ${err.message}`);
    }
    const rules = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
    const neverReview = Array.isArray(parsed) ? [] : parsed.never_review ?? [];
    return new RuleEngine(rules, kb, { warn, neverReview });
  }

  match(tx) {
    const amount = Number(tx.amount);
    for (const rule of this.rules) {
      if (rule.amountMin != null && Math.abs(amount) < rule.amountMin) continue;
      if (rule.amountMax != null && Math.abs(amount) > rule.amountMax) continue;
      if (rule.sign === 'debit' && !(amount > 0)) continue;
      if (rule.sign === 'credit' && !(amount < 0)) continue;
      if (rule.accountIds) {
        const acct = tx.plaid_account_id ?? tx.manual_account_id;
        if (!rule.accountIds.includes(acct)) continue;
      }
      const haystack = rule.fields.map((f) => tx[f] ?? '').join(' ␟ ');
      if (!rule.regex.test(haystack)) continue;

      return {
        tier: 'rule',
        name: rule.name,
        categoryId: rule.categoryId,
        confidence: 1,
        reason: `rule "${rule.name}"`,
        notes: rule.notes,
        review: rule.review,
      };
    }
    return null;
  }

  /**
   * Name of the hold covering this transaction, or null. A held transaction can
   * still be categorized — it just never gets its review flag cleared for you.
   */
  holdsReview(tx) {
    for (const hold of this.holds) {
      const haystack = hold.fields.map((f) => tx[f] ?? '').join(' ␟ ');
      if (hold.regex.test(haystack)) return hold.name;
    }
    return null;
  }

  get size() {
    return this.rules.length;
  }

  get holdCount() {
    return this.holds.length;
  }
}
