import { config, requireToken } from './config.js';
import { sleep, chunk } from './util.js';

/**
 * Sliding-window limiter. The API allows 100 req/min per IP; we stay under
 * that with headroom so a concurrently-running sync doesn't push us over.
 * https://lunchmoney.dev/v2/rate-limits
 */
class RateLimiter {
  constructor(max = 85, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = [];
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      if (this.hits.length < this.max) {
        this.hits.push(now);
        return;
      }
      await sleep(this.windowMs - (now - this.hits[0]) + 50);
    }
  }
}

export class LunchMoneyError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'LunchMoneyError';
    this.status = status;
    this.body = body;
  }
}

export class LunchMoney {
  constructor({ token = requireToken(), baseUrl = config.lmBaseUrl, verbose = false } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.verbose = verbose;
    this.limiter = new RateLimiter();
    this.requestCount = 0;
  }

  async request(method, path, { query, body, maxRetries = 4 } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    for (;;) {
      await this.limiter.take();
      this.requestCount++;
      if (this.verbose) console.error(`  → ${method} ${url.pathname}${url.search}`);

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt++ < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new LunchMoneyError(`Network error calling ${method} ${path}: ${err.message}`);
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 30;
        if (attempt++ < maxRetries) {
          if (this.verbose) console.error(`  ⏳ rate limited, waiting ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          continue;
        }
      }
      if (res.status >= 500 && attempt++ < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 204) return null;

      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
      }

      if (!res.ok) {
        const detail =
          json?.errors?.map((e) => e.errMsg || JSON.stringify(e)).join('; ') ||
          json?.message ||
          text.slice(0, 300) ||
          res.statusText;
        if (res.status === 401) {
          throw new LunchMoneyError(
            `Unauthorized (401). Check LUNCH_MONEY_TOKEN — it must be a v2 access token.`,
            { status: 401, body: json }
          );
        }
        throw new LunchMoneyError(`${method} ${path} failed (${res.status}): ${detail}`, {
          status: res.status,
          body: json,
        });
      }
      return json;
    }
  }

  async getCategories({ format = 'flattened' } = {}) {
    const res = await this.request('GET', '/categories', { query: { format } });
    return res?.categories ?? [];
  }

  async getManualAccounts() {
    const res = await this.request('GET', '/manual_accounts');
    return res?.manual_accounts ?? res?.accounts ?? [];
  }

  async getPlaidAccounts() {
    const res = await this.request('GET', '/plaid_accounts');
    return res?.plaid_accounts ?? res?.accounts ?? [];
  }

  /**
   * Page through GET /transactions until has_more is false or `max` is reached.
   * `max: null` means "everything that matches".
   */
  async getTransactions(query = {}, { max = null, onPage = null } = {}) {
    const pageSize = Math.min(500, max ?? 500);
    const out = [];
    let offset = 0;
    for (;;) {
      const limit = max === null ? pageSize : Math.min(pageSize, max - out.length);
      if (limit <= 0) break;
      const res = await this.request('GET', '/transactions', {
        query: { ...query, limit, offset },
      });
      const batch = res?.transactions ?? [];
      out.push(...batch);
      if (onPage) onPage(out.length, res?.has_more);
      if (!res?.has_more || batch.length === 0) break;
      offset += batch.length;
      if (max !== null && out.length >= max) break;
    }
    return out;
  }

  /**
   * PUT /transactions — bulk update, max 500 per call.
   * `updates` is [{ id, category_id?, status?, notes? }, ...]
   */
  async updateTransactions(updates) {
    const results = [];
    for (const batch of chunk(updates, 500)) {
      const res = await this.request('PUT', '/transactions', { body: { transactions: batch } });
      results.push(res);
    }
    return results;
  }

  async deleteTransaction(id) {
    return this.request('DELETE', `/transactions/${id}`);
  }
}
