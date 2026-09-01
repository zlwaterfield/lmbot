import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, loadOrders, matchTransaction, describeItems } from '../src/amazon.js';

const fail = [];

// --- CSV parsing: product names contain commas, quotes and newlines ----------
const rows = parseCsv('a,b,c\n"has, comma","has ""quote""","has\nnewline"\n');
if (rows.length !== 2) fail.push(`expected 2 rows, got ${rows.length}`);
if (rows[1][0] !== 'has, comma') fail.push('comma inside quotes must be preserved');
if (rows[1][1] !== 'has "quote"') fail.push('escaped quotes must be unescaped');
if (rows[1][2] !== 'has\nnewline') fail.push('newline inside quotes must be preserved');

// --- order grouping ---------------------------------------------------------
const csv = [
  'Order Date,Order ID,Order Status,Product Name,Total Amount,Unit Price,Currency,Original Quantity',
  '2026-03-01T10:00:00Z,111,Closed,"Vitamin D3, 5000 IU",45.00,20.00,CAD,1',
  '2026-03-01T10:00:00Z,111,Closed,"Magnesium Glycinate",45.00,25.00,CAD,1',
  '2026-03-05T10:00:00Z,222,Closed,"Dish Soap Refill",12.50,12.50,CAD,2',
  '2026-03-09T10:00:00Z,333,Cancelled,"Never Shipped Thing",99.99,99.99,CAD,1',
  '2026-03-20T10:00:00Z,444,Closed,"Paperback Novel",30.00,14.00,CAD,1',
  '2026-03-20T10:00:00Z,444,Closed,"Notebook",30.00,16.00,CAD,1',
].join('\n');
const tmp = path.join(os.tmpdir(), `lmbot-amazon-${process.pid}.csv`);
fs.writeFileSync(tmp, csv);
const { orders, cancelled } = loadOrders(tmp);

if (orders.length !== 3) fail.push(`expected 3 orders after grouping, got ${orders.length}`);
if (cancelled !== 1) fail.push('a cancelled order must be dropped — it was never charged');
if (orders.find((o) => o.id === '333')) fail.push('cancelled orders must not be matchable');
const multi = orders.find((o) => o.id === '111');
if (multi?.items.length !== 2) fail.push('a multi-item order must keep both items');
if (multi?.total !== 45) fail.push('order total must not be summed across repeated rows');

const tx = (date, amount) => ({ date, amount: String(amount), currency: 'cad' });

// --- matching ---------------------------------------------------------------
const byTotal = matchTransaction(tx('2026-03-02', 45.0), orders);
if (byTotal?.order?.id !== '111') fail.push('a charge should match its order total a day later');
if (byTotal?.via !== 'order total') fail.push('match reason should be the order total');
if (!describeItems(byTotal).includes('Vitamin D3')) fail.push('items must be described for the model');
if (!describeItems(byTotal).includes('Magnesium')) fail.push('all items of a multi-item order must be listed');

// A split shipment is billed per parcel, so a single item price must match too.
const byItem = matchTransaction(tx('2026-03-20', 14.0), orders);
if (byItem?.order?.id !== '444' || byItem.via !== 'single item') fail.push('a split shipment should match on unit price');
if (describeItems(byItem).includes('Notebook')) fail.push('a single-item match must describe only that item');

// Outside the window, and refunds, must not match.
if (matchTransaction(tx('2026-04-20', 45.0), orders)) fail.push('a charge a month later must not match');
if (matchTransaction(tx('2026-03-02', -45.0), orders)) fail.push('a refund must not be matched to an order');
if (matchTransaction(tx('2026-03-02', 99.99), orders)) fail.push('a cancelled order must never match');

// Two orders at the same amount are ambiguous, not a coin flip.
const dupCsv = csv + '\n2026-03-02T10:00:00Z,555,Closed,"Different Thing",45.00,45.00,CAD,1';
fs.writeFileSync(tmp, dupCsv);
const dup = loadOrders(tmp).orders;
const amb = matchTransaction(tx('2026-03-02', 45.0), dup);
if (amb?.order) fail.push('two orders at the same amount must not resolve to one');
if (amb?.ambiguous?.length !== 2) fail.push('both candidate orders must be reported as ambiguous');

// A non-Amazon CSV should fail loudly rather than silently produce nothing.
fs.writeFileSync(tmp, 'foo,bar\n1,2\n');
let threw = false;
try { loadOrders(tmp); } catch { threw = true; }
if (!threw) fail.push('a CSV without the expected columns must throw');

fs.rmSync(tmp, { force: true });
console.log(fail.length ? '✗ ' + fail.join('\n✗ ') : '✓ amazon: 18 assertions passed');
process.exit(fail.length ? 1 : 0);
