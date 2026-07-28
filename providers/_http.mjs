// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

import './_dns-cache.mjs'; // memoize dns.lookup process-wide (see that file)

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

/**
 * Browser-like User-Agent for providers that must clear WAF/CDN bot
 * management blocking the default career-ops UA outright (seen live:
 * Glints' firewall, Geico's Cloudflare-gated Workday tenant). Shared so
 * every provider working around such a block bumps one constant instead
 * of drifting Chrome versions independently per file.
 */
export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Transient statuses worth retrying on an idempotent request. 429 is the one
 * that actually bites: rate-limited list APIs throttle rapid pagination, and
 * without a backoff a single 429 aborts the whole company scan partway
 * through. Providers that page hard (Eightfold-derived tenants, Microsoft
 * PCS-X) hit this routinely.
 *
 * The timeout is per attempt, not per call: a retried GET can now take up to
 * (MAX_RETRIES + 1) * timeoutMs plus the backoff waits.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 600;
const BACKOFF_CAP_MS = 8_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After is either delta-seconds or an HTTP date. Returns ms, or null. */
function parseRetryAfter(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/** Exponential backoff, capped, with half jitter so retries do not synchronize. */
function backoffMs(attempt) {
  const expo = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return expo / 2 + Math.floor(Math.random() * (expo / 2));
}

/**
 * One HTTP attempt, guarded by an abort timer. Every body read stays INSIDE
 * the timer window: a server that sends headers and then stalls the body
 * otherwise hangs the caller forever (this froze full-directory sweeps
 * silently — 20 workers all stuck on stalled reads with the abort timer
 * already cleared).
 *
 * On success the body is read via `consume` (json/text). On an error status
 * the body text is drained here too — both to attach as err.body and so the
 * connection is freed for reuse before a retry backoff. The result is a
 * discriminated object so the retry loop can decide on status/Retry-After
 * without holding an unconsumed body across the timer boundary.
 */
async function fetchOnce(url, { timeoutMs, headers, method, body, redirect }, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (res.ok) {
      return { ok: true, value: await consume(res) };
    }
    // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
    // text — HTML markup or a generic interstitial message, not worth
    // parsing or displaying. The status code and its standard reason phrase
    // are what a log line needs; the raw body is still attached as err.body
    // for callers that want to inspect it.
    const responseText = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      statusText: res.statusText,
      retryAfter: res.headers.get('retry-after'),
      body: responseText,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}, consume) {
  const opts = { timeoutMs, headers, method, body, redirect };
  // Only idempotent GETs are retried, so a POST is never silently re-sent.
  const canRetry = method === 'GET';

  for (let attempt = 0; ; attempt++) {
    const r = await fetchOnce(url, opts, consume);
    if (r.ok) return r.value;

    if (canRetry && RETRYABLE_STATUS.has(r.status) && attempt < MAX_RETRIES) {
      // The error body was already drained inside fetchOnce's timer window.
      const wait = parseRetryAfter(r.retryAfter) ?? backoffMs(attempt);
      await sleep(wait);
      continue;
    }

    const err = new Error(`HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`);
    err.status = r.status;
    err.body = r.body;
    err.retryAfter = r.retryAfter;
    throw err;
  }
}

export async function fetchJson(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.json());
}

export async function fetchText(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res) => res.text());
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
