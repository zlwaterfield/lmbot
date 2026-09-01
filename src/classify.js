import { RuleEngine } from './rules.js';
import { Memory } from './memory.js';
import { Classifier } from './llm.js';

/**
 * The cascade: rules → memory → LLM. Each tier only sees what the tier above
 * it could not answer, so the expensive tier runs on the smallest possible set.
 */
export class Cascade {
  constructor({ kb, rules, memory, classifier, minConfidence = 0.7 }) {
    this.kb = kb;
    this.rules = rules;
    this.memory = memory;
    this.classifier = classifier;
    this.minConfidence = minConfidence;
  }

  static async create({ kb, useLlm = true, minConfidence = 0.7, verbose = false, warn }) {
    const rules = RuleEngine.load(kb, { warn });
    const memory = Memory.load();
    const classifier = useLlm ? new Classifier({ kb, verbose }) : null;
    return new Cascade({ kb, rules, memory, classifier, minConfidence });
  }

  /**
   * Returns { suggestions: Map<txId, suggestion>, skipped: [{tx, why}] }.
   * A suggestion is { tier, categoryId, confidence, reason, notes?, review? }.
   */
  async run(transactions, { onLlmProgress = null, llmBatchSize = 25 } = {}) {
    const suggestions = new Map();
    const remaining = [];

    for (const tx of transactions) {
      const hit = this.rules.match(tx);
      if (hit) {
        suggestions.set(tx.id, hit);
        continue;
      }
      const remembered = this.memory.match(tx);
      if (remembered && remembered.confidence >= this.minConfidence) {
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

export function tierLabel(tier) {
  return { rule: 'rule', memory: 'memory', llm: 'llm' }[tier] ?? tier;
}
