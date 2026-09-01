import fs from 'node:fs';

/** RFC 4180 parser — product names contain commas, quotes and newlines. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Collapse the item-level export into orders.
 *
 * Amazon repeats the order total on every line of a multi-item order, so the
 * rows must be grouped before the totals can be compared against a bank charge.
 * Cancelled orders are dropped — they were never charged, and leaving them in
 * creates phantom matches at exactly the amounts most likely to collide.
 */
export function loadOrders(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error(`${csvPath} is empty`);

  const head = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  const col = (name) => {
    const i = head.indexOf(name);
    if (i === -1) throw new Error(`${csvPath} has no "${name}" column — is this an Amazon order history export?`);
    return i;
  };
  const [cDate, cId, cStatus, cName, cTotal, cUnit, cCur, cQty] = [
    'Order Date', 'Order ID', 'Order Status', 'Product Name',
    'Total Amount', 'Unit Price', 'Currency', 'Original Quantity',
  ].map(col);

  const orders = new Map();
  let cancelled = 0;

  for (const row of rows.slice(1)) {
    if (row.length < head.length - 2) continue;
    const status = (row[cStatus] ?? '').trim();
    if (/cancel/i.test(status)) {
      cancelled++;
      continue;
    }
    const id = (row[cId] ?? '').trim();
    const total = Number(row[cTotal]);
    const date = (row[cDate] ?? '').slice(0, 10);
    if (!id || !date || !Number.isFinite(total)) continue;

    if (!orders.has(id)) {
      orders.set(id, {
        id,
        date,
        total,
        currency: (row[cCur] ?? 'CAD').trim().toLowerCase(),
        items: [],
      });
    }
    const order = orders.get(id);
    const name = (row[cName] ?? '').trim();
    if (name) {
      order.items.push({
        name,
        unit: Number(row[cUnit]) || null,
        qty: Number(row[cQty]) || 1,
      });
    }
  }

  return { orders: [...orders.values()], cancelled };
}

const dayMs = 86_400_000;
const daysApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / dayMs;
const cents = (n) => Math.round(Number(n) * 100);

/**
 * Match a bank charge to an order.
 *
 * Amazon charges on shipment, not on order, so the dates drift by days; the
 * amount is the reliable key. An order total is tried first, then a single
 * item's price, since a split shipment is billed per parcel.
 *
 * Two orders at the same amount inside the window are reported as ambiguous
 * rather than resolved by guessing — picking the nearer date would be a coin
 * flip, and the whole point is knowing what was actually bought.
 */
export function matchTransaction(tx, orders, { days = 7 } = {}) {
  const amount = cents(tx.amount);
  if (amount <= 0) return null; // refunds and credits have no single order

  const inWindow = orders.filter((o) => daysApart(o.date, tx.date) <= days);

  const byTotal = inWindow.filter((o) => cents(o.total) === amount);
  if (byTotal.length === 1) return { order: byTotal[0], via: 'order total' };
  if (byTotal.length > 1) {
    return { order: null, ambiguous: byTotal, via: 'order total' };
  }

  // Split shipment: the charge covers one item of a larger order.
  const byItem = [];
  for (const order of inWindow) {
    for (const item of order.items) {
      if (item.unit != null && cents(item.unit) === amount) byItem.push({ order, item });
    }
  }
  if (byItem.length === 1) {
    return { order: byItem[0].order, item: byItem[0].item, via: 'single item' };
  }
  if (byItem.length > 1) {
    return { order: null, ambiguous: byItem.map((b) => b.order), via: 'single item' };
  }

  return null;
}

/** What the LLM is told a transaction contained. */
export function describeItems(match, limit = 6) {
  if (!match?.order) return '';
  const items = match.item ? [match.item] : match.order.items;
  const names = items.slice(0, limit).map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
  const extra = items.length - names.length;
  return names.join(' | ') + (extra > 0 ? ` | (+${extra} more)` : '');
}
