import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from './config.js';
import { chunk } from './util.js';

const ResultSchema = z.object({
  results: z.array(
    z.object({
      ref: z.number().int().describe('The ref number of the transaction being categorized'),
      category_id: z
        .number()
        .int()
        .describe('The chosen category id, or 0 if no category is a good fit'),
      confidence: z.number().min(0).max(1).describe('How confident you are, 0 to 1'),
      reason: z.string().max(120).describe('A short justification, under 15 words'),
    })
  ),
});

const NameSchema = z.object({
  results: z.array(
    z.object({
      ref: z.number().int().describe('The ref number of the merchant being named'),
      name: z.string().max(40).describe('The clean merchant display name'),
      confidence: z.number().min(0).max(1).describe('How confident you are, 0 to 1'),
    })
  ),
});

const NAMING_PREAMBLE = `You clean up merchant names from raw bank transaction descriptors.

For each entry you are given the raw bank descriptor and the names currently in the ledger. Return the merchant's real, human-readable display name.

Rules:
- Return the merchant's actual brand name, correctly capitalized: "STARBUCKS 8007827282 800-782-7282" is "Starbucks", "SQ *BLUE BOTTLE 4471" is "Blue Bottle".
- Strip store numbers, phone numbers, reference codes, city and state, and payment-processor prefixes (SQ, TST, PAYPAL, POS).
- Keep a genuine distinction: "Amazon" and "Amazon Web Services" are different merchants and must not be collapsed into one.
- Use the brand's own capitalization where it is well known (McDonald's, IKEA, eBay, AT&T, DoorDash).
- Do not invent a merchant. If the descriptor is too garbled to identify, return the cleanest literal reading of it and set confidence below 0.5.
- Never add words that are not supported by the descriptor — no guessing a category, city, or parent company.
- Return exactly one result per entry, echoing its ref.`;

const SYSTEM_PREAMBLE = `You categorize personal financial transactions for a Lunch Money budget.

You will be given the user's own category list and a batch of transactions. For each transaction, pick the single best category id from the list.

Rules:
- Only ever return a category id that appears in the list below. Never invent one.
- Amounts are positive for money out (a debit/expense) and negative for money in (a credit/refund/income). Only use a category flagged INCOME for negative amounts.
- \`descriptor\` is the raw bank text and is usually more informative than \`payee\`.
- If you genuinely cannot tell what the merchant is, return category_id 0 with low confidence rather than guessing. A wrong category is worse than none — it will be silently applied to the user's real budget.
- Prefer the specific category over a generic catch-all when the merchant is clear.
- Judge each transaction independently, but do use recurring patterns in the batch as evidence.
- Return exactly one result per transaction, echoing its ref.`;

export class Classifier {
  constructor({ kb, model = config.model, apiKey = config.anthropicKey, verbose = false } = {}) {
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set, so the LLM tier is unavailable.\n' +
        'Either add it to .env, or run with --no-llm to use rules + memory only.'
      );
    }
    this.client = new Anthropic({ apiKey });
    this.kb = kb;
    this.model = model;
    this.verbose = verbose;
    this.usage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
  }

  #system() {
    return [
      {
        type: 'text',
        text: `${SYSTEM_PREAMBLE}\n\n# Available categories\n\n${this.kb.toPrompt()}`,
        // The category list is identical across every batch in a run, so cache it.
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  static #render(tx, ref) {
    const fields = [
      `ref=${ref}`,
      `date=${tx.date}`,
      `amount=${tx.amount} ${String(tx.currency || 'usd').toUpperCase()}`,
      `payee=${JSON.stringify(tx.payee ?? '')}`,
    ];
    if (tx.original_name && tx.original_name !== tx.payee) {
      fields.push(`descriptor=${JSON.stringify(tx.original_name)}`);
    }
    if (tx.notes) fields.push(`notes=${JSON.stringify(tx.notes)}`);
    if (tx.account_name) fields.push(`account=${JSON.stringify(tx.account_name)}`);
    if (tx.recurring_id) fields.push('recurring=true');
    return fields.join(' ');
  }

  /**
   * Classify a list of transactions. Returns a Map of transaction id -> suggestion.
   * Batched to keep each request small and to bound the blast radius of a bad response.
   */
  async classify(transactions, { batchSize = 25, onProgress = null } = {}) {
    const out = new Map();
    const batches = chunk(transactions, batchSize);

    for (const [i, batch] of batches.entries()) {
      const refs = new Map(batch.map((tx, idx) => [idx + 1, tx]));
      const lines = batch.map((tx, idx) => Classifier.#render(tx, idx + 1)).join('\n');

      let response;
      try {
        response = await this.client.messages.parse({
          model: this.model,
          max_tokens: 8000,
          system: this.#system(),
          messages: [
            {
              role: 'user',
              content: `Categorize these ${batch.length} transactions:\n\n${lines}`,
            },
          ],
          output_config: {
            format: zodOutputFormat(ResultSchema),
            effort: 'low',
          },
        });
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
          throw new Error(`Anthropic rate limit hit after ${this.usage.calls} calls: ${err.message}`);
        }
        if (err instanceof Anthropic.AuthenticationError) {
          throw new Error('Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
        }
        throw err;
      }

      this.usage.calls++;
      this.usage.input += response.usage?.input_tokens ?? 0;
      this.usage.output += response.usage?.output_tokens ?? 0;
      this.usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        throw new Error(
          `The model declined to answer batch ${i + 1} (${response.stop_details?.category ?? 'unknown'}).`
        );
      }

      const parsed = response.parsed_output;
      if (!parsed) {
        console.error(`  ⚠ batch ${i + 1}: could not parse a structured response, skipping`);
        continue;
      }

      for (const result of parsed.results) {
        const tx = refs.get(result.ref);
        if (!tx) continue;
        if (result.category_id === 0) continue;
        // Guard against a hallucinated or group-level id reaching the API.
        if (!this.kb.isAssignable(result.category_id)) {
          if (this.verbose) {
            console.error(`  ⚠ model returned unusable category ${result.category_id}, dropping`);
          }
          continue;
        }
        out.set(tx.id, {
          tier: 'llm',
          categoryId: result.category_id,
          confidence: result.confidence,
          reason: result.reason,
        });
      }

      if (onProgress) onProgress(i + 1, batches.length);
    }
    return out;
  }

  /**
   * Propose clean display names for merchant clusters.
   * `clusters` is [{ key, descriptor, variants: [string], count }].
   * Returns a Map of key -> { name, confidence }.
   */
  async namePayees(clusters, { batchSize = 40, onProgress = null } = {}) {
    const out = new Map();
    const batches = chunk(clusters, batchSize);

    for (const [i, batch] of batches.entries()) {
      const refs = new Map(batch.map((entry, idx) => [idx + 1, entry]));
      const lines = batch
        .map((entry, idx) =>
          `ref=${idx + 1} descriptor=${JSON.stringify(entry.descriptor ?? '')} ` +
          `current=${JSON.stringify(entry.variants.slice(0, 4))} seen=${entry.count}`
        )
        .join('\n');

      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 8000,
        system: [{ type: 'text', text: NAMING_PREAMBLE, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Clean up these ${batch.length} merchant names:\n\n${lines}` }],
        output_config: { format: zodOutputFormat(NameSchema), effort: 'low' },
      });

      this.usage.calls++;
      this.usage.input += response.usage?.input_tokens ?? 0;
      this.usage.output += response.usage?.output_tokens ?? 0;
      this.usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        throw new Error(`The model declined to name batch ${i + 1}.`);
      }
      if (!response.parsed_output) {
        console.error(`  ⚠ batch ${i + 1}: could not parse a structured response, skipping`);
        continue;
      }

      for (const result of response.parsed_output.results) {
        const entry = refs.get(result.ref);
        if (!entry) continue;
        const name = String(result.name ?? '').trim();
        if (!name || name.length > 40) continue;
        out.set(entry.key, { name, confidence: result.confidence });
      }

      if (onProgress) onProgress(i + 1, batches.length);
    }
    return out;
  }

  costNote() {
    const { input, output, cacheRead, calls } = this.usage;
    return `${calls} LLM call${calls === 1 ? '' : 's'} · ${input.toLocaleString()} in / ${output.toLocaleString()} out tokens` +
      (cacheRead ? ` · ${cacheRead.toLocaleString()} cached` : '');
  }
}
