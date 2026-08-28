// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Microsoft provider — hits the public PCS-X careers search API (GET, paginated,
// zero-auth, no token or cookie).
//
//   GET https://apply.careers.microsoft.com/api/pcsx/search
//       ?domain=microsoft.com&query=<q>&location=<loc>&start=<n>
//   -> { status, data: { positions: [...], count: <total> }, metadata }
//
// Microsoft's careers site (jobs.careers.microsoft.com) is a PCS-X /
// Eightfold-derived SPA that loads jobs from apply.careers.microsoft.com's
// /api/pcsx/search. The legacy gcsservices.careers.microsoft.com endpoint is
// retired (404). detect() claims any *.careers.microsoft.com careers_url, but
// every REQUEST is pinned to the single API host below — the careers_url host
// is never fetched, so a stray subdomain can't widen the SSRF surface.
//
// Per position: id, name, positionUrl, standardizedLocations[] / locations[],
// postedTs (epoch SECONDS). Microsoft honours `location=` server-side, so a
// `location:` override pre-narrows the board (unlike google, which ignores it).
//
// Config (nested `microsoft:` block is canonical; flat keys kept for back-compat):
//   microsoft: { query: "backend engineer", location: "Redmond" }
//   # or, legacy-flat:  query: "backend engineer"   location: "Redmond"
// Both are optional — query defaults to "software engineer", location to unset.

import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry } from './_http.mjs';

// The only host this provider ever fetches. detect() accepts *.careers.microsoft.com
// careers_urls, but the search API lives here and requests are pinned to it.
const API_HOST = 'apply.careers.microsoft.com';
const DOMAIN = 'microsoft.com';

// pcsx/search returns 10 rows per page regardless of the requested size, so
// pagination is mandatory rather than an optimization.
const PAGE_SIZE = 10;
// Safety cap on pagination, applied regardless of what `count` claims, so a
// misbehaving or compromised API cannot drive an unbounded request loop.
// 30 pages = 300 postings; override with `max_pages` on the portal entry.
const DEFAULT_MAX_PAGES = 30;
// Hard ceiling even for an explicit override (1,000 postings).
const MAX_PAGES_CAP = 100;
// Same-host pacing between pages inside one board's pagination loop.
const INTER_PAGE_DELAY_MS = 250;

const DEFAULT_QUERY = 'software engineer';
const RETRY_POLICY = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

// A careers_url host is Microsoft's careers site when it is `careers.microsoft.com`
// or a subdomain of it — anchored so `evilcareers.microsoft.com` (which a bare
// endsWith check would accept) is rejected.
const MS_CAREERS_HOST_RE = /(^|\.)careers\.microsoft\.com$/i;

/**
 * SSRF guard — every request URL passes through here before it is fetched. The
 * host is a constant (API_HOST), never derived from the entry, so this can only
 * ever pass for the pinned Microsoft API host over HTTPS.
 *
 * @param {string} url
 * @returns {string} the same URL, when it is the trusted Microsoft API endpoint.
 */
function assertMicrosoftUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`microsoft: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`microsoft: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== API_HOST) {
    throw new Error(`microsoft: untrusted hostname "${parsed.hostname}" — must be ${API_HOST}`);
  }
  return url;
}

/** @param {string} url */
function isMicrosoftCareers(url) {
  try {
    return MS_CAREERS_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * postedTs / creationTs are unix seconds; normalize to ms. Anything non-finite
 * or non-positive is dropped rather than guessed at. Values already in ms
 * (>= 1e12) pass through, so a source that switches units doesn't date to 1970.
 *
 * @param {unknown} value
 * @returns {number|undefined} epoch ms, or undefined.
 */
function toEpochMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** @param {number} ms @param {any} ctx */
function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the search knobs from a portal entry. The nested `microsoft: {...}` block
 * is the canonical form (matches phenom's `entry.phenom`); the flat `query` /
 * `location` keys are still honoured so a pre-existing portals.yml keeps working.
 * Nested wins over flat when both are present.
 *
 * @param {any} entry
 * @returns {{query: string, location: string}}
 */
export function readSearchConfig(entry) {
  const nested = entry && typeof entry.microsoft === 'object' && entry.microsoft ? entry.microsoft : {};
  const pick = (key) => {
    const nv = nested[key];
    if (typeof nv === 'string' && nv.trim()) return nv.trim();
    const fv = entry?.[key];
    if (typeof fv === 'string' && fv.trim()) return fv.trim();
    return '';
  };
  return { query: pick('query') || DEFAULT_QUERY, location: pick('location') };
}

/**
 * Build the pcsx/search URL for one page.
 *
 * @param {{query: string, location: string}} search
 * @param {number} [start] - Row offset (0-based).
 * @returns {string}
 */
export function buildApiUrl(search, start = 0) {
  const params = new URLSearchParams();
  params.set('domain', DOMAIN);
  params.set('query', search.query);
  if (search.location) params.set('location', search.location);
  params.set('start', String(start));
  return `https://${API_HOST}/api/pcsx/search?${params.toString()}`;
}

/**
 * Assemble a location string. Prefers `standardizedLocations` ("Redmond, WA, US"),
 * which reads cleaner for scan.mjs's location_filter than the verbose `locations`
 * strings; falls back to `locations`. Deduped, joined with " · " like ashby's
 * secondaryLocations handling so a multi-site role exposes every city.
 *
 * @param {any} p
 * @returns {string}
 */
function assembleLocation(p) {
  const source = Array.isArray(p.standardizedLocations) && p.standardizedLocations.length
    ? p.standardizedLocations
    : (Array.isArray(p.locations) ? p.locations : []);
  const parts = [];
  for (const loc of source) {
    if (typeof loc === 'string' && loc.trim()) parts.push(loc.trim());
  }
  return [...new Set(parts)].join(' · ');
}

/**
 * Pure normalizer for one `/api/pcsx/search` response. Exported for unit tests.
 * Returns [] for null / {} / non-array / {data: {positions: null}}.
 *
 * Drop rules (a dropped row is silently omitted, never emitted half-formed):
 *   - no title (`name`)
 *   - no `id` — it is both the dedup-URL source and required to build the
 *     fallback posting URL. A row with a positionUrl but no id is still dropped:
 *     without an id there is nothing stable to key on.
 *
 * @param {unknown} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseMicrosoftResponse(json, companyName) {
  if (!json || typeof json !== 'object') return [];
  const data = /** @type {any} */ (json).data;
  if (!data || typeof data !== 'object') return [];
  const positions = data.positions;
  if (!Array.isArray(positions)) return [];

  const out = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;

    const title = typeof p.name === 'string' ? p.name.trim() : '';
    if (!title) continue;

    const id = p.id != null && `${p.id}`.trim() ? `${p.id}`.trim() : '';
    if (!id) continue;

    const path = typeof p.positionUrl === 'string' && p.positionUrl.trim()
      ? p.positionUrl.trim()
      : `/careers/job/${id}`;
    const url = /^https?:\/\//i.test(path) ? path : `https://${API_HOST}${path.startsWith('/') ? '' : '/'}${path}`;

    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title, url, company: companyName, location: assembleLocation(p) };
    const postedAt = toEpochMs(p.postedTs) ?? toEpochMs(p.creationTs);
    if (postedAt !== undefined) job.postedAt = postedAt;

    out.push(job);
  }
  return out;
}

/**
 * Resolve the page cap: a positive integer `max_pages` on the entry, capped at
 * MAX_PAGES_CAP; then narrowed further by ctx.maxPages when the caller is only
 * probing (verify-portals.mjs's health check passes 1).
 *
 * @param {any} entry
 * @param {any} ctx
 * @returns {number}
 */
function resolveMaxPages(entry, ctx) {
  const v = entry?.max_pages;
  const fromEntry = Number.isInteger(v) && v > 0 ? Math.min(v, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(fromEntry, Math.floor(hint)) : fromEntry;
}

/** @type {Provider} */
export default {
  id: 'microsoft',

  detect(entry) {
    return isMicrosoftCareers(entry?.careers_url || '')
      ? { url: `https://${API_HOST}/api/pcsx/search` }
      : null;
  },

  async fetch(entry, ctx) {
    if (!isMicrosoftCareers(entry?.careers_url || '')) {
      throw new Error(`microsoft: entry ${entry?.name} is not a *.careers.microsoft.com careers_url`);
    }

    const search = readSearchConfig(entry);
    const maxPages = resolveMaxPages(entry, ctx);
    const all = [];
    /** @type {number|null} */
    let total = null;

    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      if (total !== null && start >= total) break;

      const apiUrl = buildApiUrl(search, start);
      assertMicrosoftUrl(apiUrl); // SSRF guard before every fetch
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const json = /** @type {any} */ (await fetchJsonWithRetry(
        /** @type {any} */ (ctx),
        apiUrl,
        {
          // redirect:'error' prevents SSRF via a server-side redirect; with
          // assertMicrosoftUrl above it guarantees the final host stays pinned.
          redirect: 'error',
          headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
        },
        RETRY_POLICY,
      ));

      all.push(...parseMicrosoftResponse(json, entry.name));

      const positions = Array.isArray(json?.data?.positions) ? json.data.positions : [];
      if (total === null && typeof json?.data?.count === 'number' && Number.isFinite(json.data.count)) {
        total = json.data.count;
      }

      // Stop conditions: a short/empty page is the end of the board; and once
      // we have paged past `count` there is nothing left to ask for.
      if (positions.length < PAGE_SIZE) break;
      if (total !== null && start + PAGE_SIZE >= total) break;
    }

    if (total !== null && all.length < total && maxPages * PAGE_SIZE < total) {
      console.error(`⚠️  microsoft: ${entry.name} truncated at max_pages=${maxPages} (${all.length} of ${total} jobs) — raise max_pages on this entry for more`);
    }

    return all;
  },
};
