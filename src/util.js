export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function money(amount, currency = 'usd') {
  const n = Number(amount);
  const sign = n < 0 ? '-' : '';
  return `${sign}${currency.toUpperCase() === 'USD' ? '$' : ''}${Math.abs(n).toFixed(2)}${
    currency.toUpperCase() === 'USD' ? '' : ' ' + currency.toUpperCase()
  }`;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = new Proxy(C, {
  get: (t, k) => (useColor ? t[k] ?? '' : ''),
});

export function color(name, s) {
  return `${c[name]}${s}${c.reset}`;
}

/** Render an array of objects as an aligned text table. */
export function table(rows, columns) {
  if (!rows.length) return '';
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r) => String(col.get(r) ?? '').length))
  );
  const line = (cells) =>
    cells.map((cell, i) => (columns[i].right ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join('  ');
  const out = [color('bold', line(columns.map((col) => col.header)))];
  out.push(color('dim', widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const r of rows) out.push(line(columns.map((col) => col.get(r) ?? '')));
  return out.join('\n');
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function pct(n) {
  return `${Math.round(n * 100)}%`;
}

/** Ask a yes/no question on stdin. Returns false when not a TTY. */
export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
