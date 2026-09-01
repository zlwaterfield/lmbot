import fs from 'node:fs';
import { RULES_PATH } from './config.js';

/**
 * Deterministic tier. Regex over the payee / bank descriptor, optionally gated
 * on amount, sign, or account. First matching rule wins, so order matters.
 */
export class RuleEngine {
  constructor(rules, kb, { warn = () => {} } = {}) {
    this.kb = kb;
    this.rules = [];
    this.problems = [];

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
    return new RuleEngine(rules, kb, { warn });
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

  get size() {
    return this.rules.length;
  }
}
