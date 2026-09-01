import { findDuplicates, findTransferPairs } from '../src/dupes.js';

const tx = (o) => ({
  currency: 'usd', status: 'unreviewed', category_id: null, source: 'plaid',
  is_split_parent: false, split_parent_id: null, is_group_parent: false, group_parent_id: null,
  plaid_account_id: 100, manual_account_id: null, tag_ids: [], notes: null,
  created_at: '2026-08-01T00:00:00Z', ...o,
});

const data = [
  // 1. exact duplicate, same account/date/amount/payee
  tx({ id: 1, date: '2026-08-10', amount: '42.5000', payee: 'Blue Bottle', original_name: 'SQ *BLUE BOTTLE 4471' }),
  tx({ id: 2, date: '2026-08-10', amount: '42.5000', payee: 'Blue Bottle', original_name: 'SQ *BLUE BOTTLE 4471', source: 'csv' }),

  // 2. likely duplicate: 2 days apart, descriptor differs, one is reviewed+categorized
  tx({ id: 3, date: '2026-08-12', amount: '118.2300', payee: 'Whole Foods', original_name: 'WHOLE FOODS MARKET 10287 SAN FRANCISCO CA', status: 'reviewed', category_id: 315162 }),
  tx({ id: 4, date: '2026-08-14', amount: '118.2300', payee: 'Whole Foods Mkt', original_name: 'WHOLEFOODS MKT #10287', source: 'manual' }),

  // 3. NOT a duplicate: same amount + payee but 20 days apart (a real subscription)
  tx({ id: 5, date: '2026-08-01', amount: '15.9900', payee: 'Netflix', original_name: 'NETFLIX.COM' }),
  tx({ id: 6, date: '2026-08-21', amount: '15.9900', payee: 'Netflix', original_name: 'NETFLIX.COM' }),

  // 4. NOT a duplicate: same amount/date, totally different merchants
  tx({ id: 7, date: '2026-08-05', amount: '20.0000', payee: 'Shell Oil', original_name: 'SHELL OIL 574443' }),
  tx({ id: 8, date: '2026-08-05', amount: '20.0000', payee: 'Chipotle', original_name: 'CHIPOTLE 2094 AUSTIN TX' }),

  // 5. transfer pair: equal and opposite across two accounts — must NOT be a dupe
  tx({ id: 9, date: '2026-08-15', amount: '500.0000', payee: 'Transfer to Savings', plaid_account_id: 100 }),
  tx({ id: 10, date: '2026-08-15', amount: '-500.0000', payee: 'Transfer from Checking', plaid_account_id: 200 }),

  // 6. cross-account same-amount same-sign — flagged separately, not auto-deleted
  tx({ id: 11, date: '2026-08-18', amount: '75.0000', payee: 'Costco', original_name: 'COSTCO WHSE #1021', plaid_account_id: 100 }),
  tx({ id: 12, date: '2026-08-18', amount: '75.0000', payee: 'Costco', original_name: 'COSTCO WHSE #1021', plaid_account_id: 300 }),

  // 7. split children must be excluded entirely
  tx({ id: 13, date: '2026-08-20', amount: '30.0000', payee: 'Target', split_parent_id: 999 }),
  tx({ id: 14, date: '2026-08-20', amount: '30.0000', payee: 'Target', split_parent_id: 999 }),
];

const groups = findDuplicates(data, { days: 3 });
console.log(`Found ${groups.length} duplicate groups:\n`);
for (const g of groups) {
  console.log(`  ${g.confidence.toUpperCase().padEnd(14)} $${g.amount}  ids=[${g.transactions.map(t=>t.id)}]  keep=#${g.keep.id}  delete=[${g.remove.map(t=>t.id)}]`);
}
const pairs = findTransferPairs(data, { days: 3 });
console.log(`\nTransfer pairs: ${pairs.map(p => `(${p[0].id},${p[1].id})`).join(' ')}`);

// Assertions
const fail = [];
const ids = (g) => g.transactions.map(t=>t.id).sort((a,b)=>a-b).join(',');
const find = (s) => groups.find(g => ids(g) === s);
if (!find('1,2') || find('1,2').confidence !== 'exact') fail.push('exact dupe (1,2) not detected');
if (find('1,2') && find('1,2').keep.id !== 1) fail.push('should keep the plaid record #1, not the csv one');
if (!find('3,4') || find('3,4').confidence !== 'likely') fail.push('likely dupe (3,4) not detected');
if (find('3,4') && find('3,4').keep.id !== 3) fail.push('should keep reviewed+categorized #3');
if (find('5,6')) fail.push('Netflix 20 days apart wrongly flagged');
if (find('7,8')) fail.push('different merchants, same amount wrongly flagged');
if (find('9,10')) fail.push('transfer pair wrongly flagged as duplicate');
if (!find('11,12') || find('11,12').confidence !== 'cross-account') fail.push('cross-account not classified');
if (find('13,14')) fail.push('split children must be excluded');
if (pairs.length !== 1 || pairs[0][0].id !== 9) fail.push('transfer pair detection wrong');

console.log(fail.length ? '\n✗ FAILURES:\n  ' + fail.join('\n  ') : '\n✓ all 10 assertions passed');
process.exit(fail.length ? 1 : 0);
