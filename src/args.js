/** Tiny flag parser: --flag, --flag=value, --flag value, --no-flag, -x. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (key.startsWith('no-') && value === undefined) {
        flags[key.slice(3)] = false;
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      flags[key] = value;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export function num(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  return !/^(false|0|no)$/i.test(String(value));
}

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Resolve --start/--end, --month, --year, --last-days into a date window.
 * Returns { start, end, label } with start/end as YYYY-MM-DD or null.
 */
export function resolveDateRange(flags, { defaultDays = null } = {}) {
  const { month, year, start, end } = flags;
  const lastDays = flags['last-days'] ?? flags.days;

  if (month && month !== true) {
    const m = String(month);
    const match = /^(\d{4})-(\d{1,2})$/.exec(m);
    if (!match) throw new Error(`--month must look like 2026-08, got "${m}"`);
    const [, y, mm] = match;
    const first = new Date(Date.UTC(Number(y), Number(mm) - 1, 1));
    const last = new Date(Date.UTC(Number(y), Number(mm), 0));
    return { start: iso(first), end: iso(last), label: `${y}-${String(mm).padStart(2, '0')}` };
  }

  if (year && year !== true) {
    const y = Number(year);
    if (!Number.isInteger(y)) throw new Error(`--year must be a 4-digit year, got "${year}"`);
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }

  if (lastDays !== undefined && lastDays !== true) {
    const n = Number(lastDays);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--last-days must be a positive number`);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - n * 86_400_000);
    return { start: iso(startDate), end: iso(endDate), label: `last ${n} days` };
  }

  // The API requires start and end together.
  if (start && start !== true && end && end !== true) {
    return { start: String(start), end: String(end), label: `${start} → ${end}` };
  }
  if (start && start !== true) {
    return { start: String(start), end: iso(new Date()), label: `${start} → today` };
  }
  if (end && end !== true) {
    throw new Error('--end requires --start (the API needs both).');
  }

  if (defaultDays) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - defaultDays * 86_400_000);
    return { start: iso(startDate), end: iso(endDate), label: `last ${defaultDays} days (default)` };
  }

  return { start: null, end: null, label: 'most recent' };
}
