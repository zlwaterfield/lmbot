import { qualifiesForAutoReview } from '../src/classify.js';
import { Memory } from '../src/memory.js';

const fail = [];
const check = (label, got, want) => { if (got !== want) fail.push(`${label}: got ${got}, want ${want}`); };

// A rule is your own explicit statement of intent — always qualifies.
check('rule qualifies', qualifiesForAutoReview({ tier: 'rule', confidence: 1 }), true);

// Memory needs both agreement and enough history behind it.
const mem = (observations, confidence, extra = {}) => ({ tier: 'memory', observations, confidence, ...extra });
check('memory 2× is too thin',        qualifiesForAutoReview(mem(2, 0.99)), false);
check('memory 3× at 0.99 qualifies',  qualifiesForAutoReview(mem(3, 0.99)), true);
check('memory 10× at 0.99 qualifies', qualifiesForAutoReview(mem(10, 0.99)), true);
check('memory 10× at 0.85 does not',  qualifiesForAutoReview(mem(10, 0.85)), false);
check('a fuzzy match never qualifies', qualifiesForAutoReview(mem(50, 0.99, { fuzzy: true })), false);

// The LLM is exactly the case worth a human glance.
check('llm does not qualify by default', qualifiesForAutoReview({ tier: 'llm', confidence: 0.99 }), false);
check('llm qualifies only when asked',   qualifiesForAutoReview({ tier: 'llm', confidence: 0.99 }, { allowLlm: true }), true);

// Thresholds are tunable.
check('observations threshold honored', qualifiesForAutoReview(mem(5, 0.99), { minObservations: 8 }), false);
check('confidence threshold honored',   qualifiesForAutoReview(mem(9, 0.93), { minConfidence: 0.95 }), false);
check('null suggestion', qualifiesForAutoReview(null), false);

// End to end: a payee seen twice must not auto-review, one seen five times must.
const tx = (payee, category_id) => ({ payee, original_name: payee, category_id, date: '2026-08-01' });
const built = Memory.build([
  ...Array.from({ length: 2 }, () => tx('BLUE BOTTLE 4471', 11)),
  ...Array.from({ length: 5 }, () => tx('STARBUCKS STORE 123', 11)),
]);
const twice = built.match(tx('BLUE BOTTLE 4471'));
const fiveTimes = built.match(tx('STARBUCKS STORE 123'));

if (twice?.observations !== 2) fail.push(`expected 2 observations, got ${twice?.observations}`);
if (fiveTimes?.observations !== 5) fail.push(`expected 5 observations, got ${fiveTimes?.observations}`);
check('seen 2× does not auto-review', qualifiesForAutoReview(twice), false);
check('seen 5× does auto-review',     qualifiesForAutoReview(fiveTimes), true);
// Both are still confident enough to APPLY — only the review gate differs.
if (!(twice.confidence >= 0.7)) fail.push('a 2× memory hit must still be confident enough to categorize');

console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ auto-review: 16 assertions passed');
process.exit(fail.length ? 1 : 0);
