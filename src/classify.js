import { RuleEngine } from './rules.js';
import { Memory } from './memory.js';
import { Classifier } from './llm.js';

/**
 * The cascade: rules → memory → LLM. Each tier only sees what the tier above
 * it could not answer, so the expensive tier runs on the smallest possible set.
 */
export class Cascade {
  constructor({ kb, rules, memory, classifier, minConfidence = 0.7, excludeIds = new Set() }) {
    this.kb = kb;
    this.rules = rules;
    this.memory = memory;
    this.classifier = classifier;
    this.minConfidence = minConfidence;
    // Import-default categories are never a valid answer from ANY tier. The LLM
    // is filtered at the prompt, but a stale memory.json built before that rule
    // existed can still hold poisoned entries, and a rule can name one outright.
    this.excludeIds = excludeIds;
    this.poisoned = [];
  }

  static async create({ kb, useLlm = true, minConfidence = 0.7, verbose = false, warn, excludeIds = new Set() }) {
    const rules = RuleEngine.load(kb, { warn });
    const memory = Memory.load();
    const classifier = useLlm ? new Classifier({ kb, verbose, excludeIds }) : null;
    return new Cascade({ kb, rules, memory, classifier, minConfidence, excludeIds });
  }

  /**
   * Returns { suggestions: Map<txId, suggestion>, skipped: [{tx, why}] }.
   * A suggestion is { tier, categoryId, confidence, reason, notes?, review? }.
   */
  async run(transactions, { onLlmProgress = null, llmBatchSize = 25 } = {}) {
    const suggestions = new Map();
    const remaining = [];

    const rejectPoisoned = (suggestion) => {
      if (!suggestion || !this.excludeIds.has(suggestion.categoryId)) return false;
      this.poisoned.push({ tier: suggestion.tier, categoryId: suggestion.categoryId });
      return true;
    };

    for (const tx of transactions) {
      const hit = this.rules.match(tx);
      if (hit && !rejectPoisoned(hit)) {
        suggestions.set(tx.id, hit);
        continue;
      }
      const remembered = this.memory.match(tx);
      if (remembered && remembered.confidence >= this.minConfidence && !rejectPoisoned(remembered)) {
        suggestions.set(tx.id, remembered);
        continue;
      }
      remaining.push(tx);
    }

    if (remaining.length && this.classifier) {
      const fromLlm = await this.classifier.classify(remaining, {
        batchSize: llmBatchSize,
        onProgress: onLlmProgress,
      });
      for (const [id, suggestion] of fromLlm) {
        if (suggestion.confidence >= this.minConfidence) suggestions.set(id, suggestion);
      }
    }

    const undecided = transactions.filter((tx) => !suggestions.has(tx.id));
    return { suggestions, undecided };
  }

  stats() {
    return {
      rules: this.rules.size,
      memory: this.memory.size,
      llm: this.classifier ? this.classifier.model : null,
    };
  }
}

/**
 * Should this suggestion be marked reviewed without a human looking at it?
 *
 * A rule qualifies because you wrote it: it is deterministic and already an
 * explicit statement of intent. A memory hit qualifies only when it both agrees
 * with itself and has enough history behind it — an exact payee match seen once
 * or twice is a good guess, not a settled fact. The LLM never qualifies by
 * default; deferring to it is exactly the case worth a human glance.
 */
export function qualifiesForAutoReview(suggestion, opts = {}) {
  const { minConfidence = 0.9, minObservations = 3, allowLlm = false } = opts;
  if (!suggestion) return false;

  if (suggestion.tier === 'rule') return true;

  if (suggestion.tier === 'memory') {
    if (suggestion.fuzzy) return false;
    if ((suggestion.observations ?? 0) < minObservations) return false;
    return suggestion.confidence >= minConfidence;
  }

  if (suggestion.tier === 'llm') return allowLlm && suggestion.confidence >= minConfidence;
  return false;
}

export function tierLabel(tier) {
  return { rule: 'rule', memory: 'memory', llm: 'llm' }[tier] ?? tier;
}
