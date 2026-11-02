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
 * Two layouts exist. The current one gives every line its own Total Amount —
 * that item's price, tax and shipping — so an order's total is the sum of its
 * lines, and each parcel (the lines sharing a ship date) is billed on its own.
 * An older one repeated the order total on every line. Only the current layout
 * has the per-shipment columns, so the header says which one this is.
 *
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
  const perLine = head.includes('Shipment Item Subtotal');
  const cShip = head.indexOf('Ship Date');

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
        total: perLine ? 0 : total,
        currency: (row[cCur] ?? 'CAD').trim().toLowerCase(),
        items: [],
        shipments: [],
      });
    }
    const order = orders.get(id);
    if (perLine) order.total = Math.round((order.total + total) * 100) / 100;
    const name = (row[cName] ?? '').trim();
    if (name) {
      const shipped = cShip === -1 ? '' : (row[cShip] ?? '').slice(0, 10);
      order.items.push({
        name,
        unit: Number(row[cUnit]) || null,
        qty: Number(row[cQty]) || 1,
        amount: perLine ? total : null,
        shipped: /^\d{4}-\d{2}-\d{2}$/.test(shipped) ? shipped : null,
      });
    }
  }

  for (const order of orders.values()) {
    if (!perLine) continue;
    const parcels = new Map();
    for (const item of order.items) {
      if (!item.shipped) continue;
      if (!parcels.has(item.shipped)) parcels.set(item.shipped, []);
      parcels.get(item.shipped).push(item);
    }
    // One parcel is just the order, which the order total already covers.
    if (parcels.size < 2) continue;
    for (const [date, items] of parcels) {
      order.shipments.push({
        date,
        items,
        amount: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100,
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
 * amount is the reliable key. An order total is tried first, then one parcel
 * of a split order, then a single item — each parcel is billed on its own.
 * The window counts from the order date or any ship date, since a backordered
 * parcel can ship, and be charged, weeks after the order.
 *
 * Two orders at the same amount inside the window are reported as ambiguous
 * rather than resolved by guessing — picking the nearer date would be a coin
 * flip, and the whole point is knowing what was actually bought.
 */
export function matchTransaction(tx, orders, { days = 7 } = {}) {
  const amount = cents(tx.amount);
  if (amount <= 0) return null; // refunds and credits have no single order

  const near = (date) => date != null && daysApart(date, tx.date) <= days;
  const inWindow = orders.filter((o) => near(o.date) || o.items.some((i) => near(i.shipped)));

  const byTotal = inWindow.filter((o) => cents(o.total) === amount);
  if (byTotal.length === 1) return { order: byTotal[0], via: 'order total' };
  if (byTotal.length > 1) {
    return { order: null, ambiguous: byTotal, via: 'order total' };
  }

  const byShipment = [];
  for (const order of inWindow) {
    for (const shipment of order.shipments ?? []) {
      if (cents(shipment.amount) === amount) byShipment.push({ order, items: shipment.items });
    }
  }
  const shippedOrders = new Set(byShipment.map((b) => b.order));
  if (shippedOrders.size === 1) {
    // Two parcels of one order at the same amount: the order is known, the parcel isn't.
    return byShipment.length === 1
      ? { order: byShipment[0].order, items: byShipment[0].items, via: 'shipment' }
      : { order: byShipment[0].order, via: 'shipment' };
  }
  if (shippedOrders.size > 1) {
    return { order: null, ambiguous: [...shippedOrders], via: 'shipment' };
  }

  // One item of a larger order: its own line total where the export has one
  // (price, tax and shipping — what was actually charged), else its unit price.
  const byItem = [];
  for (const order of inWindow) {
    for (const item of order.items) {
      const price = item.amount ?? item.unit;
      if (price != null && cents(price) === amount) byItem.push({ order, item });
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
  const items = match.item ? [match.item] : match.items ?? match.order.items;
  const names = items.slice(0, limit).map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
  const extra = items.length - names.length;
  return names.join(' | ') + (extra > 0 ? ` | (+${extra} more)` : '');
}

/** Marks a note as lmbot's, so a re-run refreshes it and never touches one you wrote. */
export const NOTE_PREFIX = 'Amazon: ';

// Product names run to 200 characters each; the note has to be readable in the
// app's transaction list, where it is the thing you categorize from.
const NOTE_MAX = 300;

/** "Freshfield Prenatal Omega 3 DHA Supplement: Algae…" → "Freshfield Prenatal Omega 3 DHA Supplement" */
function shortName(name) {
  const cut = name.search(/,|:| - | – | \| | \(/);
  const head = (cut >= 15 ? name.slice(0, cut) : name).trim();
  return head.length > 60 ? head.slice(0, 59).trimEnd() + '…' : head;
}

function itemNames(items, limit = 4) {
  const names = items.slice(0, limit).map((i) => (i.qty > 1 ? `${i.qty}× ` : '') + shortName(i.name));
  const extra = items.length - names.length;
  return names.join('; ') + (extra > 0 ? ` (+${extra} more)` : '');
}

/**
 * The note left on a matched charge: what was actually bought. An ambiguous
 * match lists each candidate order — the person categorizing it by hand can
 * usually tell which one it was, even though amount and date could not.
 */
export function noteFor(match) {
  let body;
  if (match?.order) body = itemNames(match.item ? [match.item] : match.items ?? match.order.items);
  else if (match?.ambiguous?.length) {
    body = `one of ${match.ambiguous.length} orders — ` +
      match.ambiguous.map((o) => itemNames(o.items, 2)).join(' / ');
  } else return null;
  const note = NOTE_PREFIX + body;
  return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX - 1) + '…' : note;
}

/** The note to write over `current`, or null to leave it as it is. */
export function nextNote(current, match) {
  const note = noteFor(match);
  if (!note || current === note) return null;
  if (current && !current.startsWith(NOTE_PREFIX)) return null;
  return note;
}
