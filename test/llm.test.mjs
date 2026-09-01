process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
const { Classifier } = await import('../src/llm.js');
const { CategoryKB } = await import('../src/kb.js');

const kb = new CategoryKB([
  { id: 10, name: 'Food', is_group: true, archived: false, group_id: null },
  { id: 11, name: 'Groceries', is_group: false, archived: false, group_id: 10, description: 'Supermarkets' },
  { id: 12, name: 'Dining Out', is_group: false, archived: false, group_id: 10 },
  { id: 20, name: 'Salary', is_group: false, archived: false, group_id: null, is_income: true },
  { id: 30, name: 'Old Stuff', is_group: false, archived: true, group_id: null },
]);

const c = new Classifier({ kb });

let captured = null;
c.client.messages.parse = async (req) => {
  captured = req;
  return {
    usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 800 },
    stop_reason: 'end_turn',
    parsed_output: {
      results: [
        { ref: 1, category_id: 11, confidence: 0.95, reason: 'supermarket' },
        { ref: 2, category_id: 20, confidence: 0.9,  reason: 'payroll deposit' },
        { ref: 3, category_id: 0,  confidence: 0.2,  reason: 'unclear merchant' },
        { ref: 4, category_id: 10, confidence: 0.9,  reason: 'group id — must be rejected' },
        { ref: 5, category_id: 30, confidence: 0.9,  reason: 'archived — must be rejected' },
        { ref: 6, category_id: 999,confidence: 0.9,  reason: 'hallucinated — must be rejected' },
        { ref: 99,category_id: 11, confidence: 0.9,  reason: 'bogus ref — must be ignored' },
      ],
    },
  };
};

const txs = [1,2,3,4,5,6].map(i => ({
  id: 1000+i, date:'2026-08-0'+i, amount:'25.00', currency:'usd',
  payee:'Merchant '+i, original_name:'RAW DESCRIPTOR '+i,
}));

const out = await c.classify(txs, { batchSize: 25 });

console.log('--- request shape ---');
console.log('model:', captured.model);
console.log('effort:', captured.output_config.effort);
console.log('has zod format:', !!captured.output_config.format, '| type:', captured.output_config.format?.type);
console.log('system is array w/ cache_control:', Array.isArray(captured.system), captured.system[0].cache_control);
console.log('system mentions all 3 assignable ids:', ['id=11','id=12','id=20'].every(s=>captured.system[0].text.includes(s)));
console.log('system excludes archived + group:', !captured.system[0].text.includes('id=30'), !captured.system[0].text.includes('id=10 '));
console.log('user msg sample:', captured.messages[0].content.split('\n')[2]);
console.log('\n--- results ---');
for (const [id, s] of out) console.log(`  tx#${id} -> cat ${s.categoryId} (${s.confidence}) ${s.reason}`);

const fail = [];
if (out.size !== 2) fail.push(`expected 2 accepted results, got ${out.size}`);
if (out.get(1001)?.categoryId !== 11) fail.push('valid leaf category not accepted');
if (out.get(1002)?.categoryId !== 20) fail.push('income category not accepted');
if (out.has(1003)) fail.push('category_id 0 (no-fit) should be dropped');
if (out.has(1004)) fail.push('group category must be rejected');
if (out.has(1005)) fail.push('archived category must be rejected');
if (out.has(1006)) fail.push('hallucinated category must be rejected');
if (captured.output_config.format?.type !== 'json_schema') fail.push('structured output format missing');
if (c.usage.calls !== 1) fail.push('usage not tracked');
console.log('\n' + (fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ all LLM-tier assertions passed'));
console.log(c.costNote());
process.exit(fail.length ? 1 : 0);
