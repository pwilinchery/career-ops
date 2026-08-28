// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// builtin.com provider — aggregator discovery feed (zero-token, no API key).
//
// builtin.com is a US-centric tech job aggregator spanning MANY employers, not a
// single tracked company, so it has NO detect() and is reached only via an
// explicit `provider: builtin` entry in portals.yml. title_filter +
// content_filter do the culling.
//
// The board is a Vue SPA, but every /jobs listing page embeds a server-side
// `ItemList` JSON blob carrying, per job:
//   {"@type":"ListItem","position":N,"name":<title>,"url":<url>,"description":<~200-400ch>}
// We parse those directly — no browser, no per-job request, zero LLM cost. The
// description ships for free, so it populates job.description and scan.mjs's
// content_filter can gate on it at scan time.
//
// NOTE (intentional): the list payload has NO company and NO location. Per the
// Job contract that's fine (empty location passes location_filter; company is
// populated downstream). Enriching every survivor would mean one GET per job —
// throttled at volume, and low-value since builtin is US-centric — so this
// provider stays list-only by design. Cull on TITLE + won't-do content negatives.
//
// Two URL forms, both server-render the ItemList and both paginate via &page=N:
//   keyword search:  https://builtin.com/jobs?search=<q>&page=<n>
//   category path:   https://builtin.com/jobs/<category>?page=<n>
// Configure per portals.yml entry (nested `builtin:` block is canonical; flat
// keys kept for back-compat):
//   builtin: { queries: ["platform engineer"], categories: [], max_pages: 3 }
//   # or, legacy-flat:  queries: [...]   categories: [...]   max_pages: 3
//
// There is NO built-in default query set: builtin has no company scope, so a
// default would be one user's personal search criteria baked into shared code.
// An entry MUST supply `queries:` and/or `categories:` — otherwise there is
// nothing to scan and fetch() returns [].

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';

const HOST = 'builtin.com';
const DEFAULT_MAX_PAGES = 3;  // builtin orders newest-first; a few pages = recent roles
const HARD_MAX_PAGES = 25;    // backstop against a misconfigured entry
const RETRY_POLICY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

// One ItemList entry. builtin emits keys in a stable order (@type, position,
// name, url, description); description is occasionally absent. Capture the three
// JSON-string fields and JSON.parse them so escaping is handled correctly.
const ITEM = /\{"@type":"ListItem","position":\d+,"name":("(?:[^"\\]|\\.)*"),"url":("(?:[^"\\]|\\.)*")(?:,"description":("(?:[^"\\]|\\.)*"))?\}/g;

/**
 * SSRF guard — every request URL passes through here before it is fetched. HOST
 * is a constant, never derived from the entry, so this only ever passes for
 * builtin.com over HTTPS.
 *
 * @param {string} url
 * @returns {string}
 */
function assertHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`builtin: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`builtin: URL must use HTTPS: ${url}`);
  if (parsed.hostname.toLowerCase() !== HOST) throw new Error(`builtin: untrusted hostname "${parsed.hostname}" — must be ${HOST}`);
  return url;
}

/**
 * Pure normalizer for one listing page's HTML. Exported for unit tests. A
 * malformed ItemList entry is skipped, never allowed to abort the whole page.
 * Rows with no title or no url are dropped (url is the dedup key downstream).
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string, description: string}>}
 */
export function parseListPage(html) {
  const jobs = [];
  if (typeof html !== 'string') return jobs;
  for (const m of html.matchAll(ITEM)) {
    let title, url, description = '';
    try {
      title = JSON.parse(m[1]);
      url = JSON.parse(m[2]);
      if (m[3]) description = JSON.parse(m[3]);
    } catch {
      continue; // a malformed item must never abort the whole page
    }
    if (!title || !url) continue;
    jobs.push({ title, url, company: '', location: '', description });
  }
  return jobs;
}

/**
 * Read the scan config. The nested `builtin: {...}` block is canonical (matches
 * phenom's `entry.phenom`); flat `queries` / `categories` / `max_pages` keys are
 * honoured so a pre-existing portals.yml keeps working. Nested wins over flat.
 *
 * NO default queries: an empty result means "nothing to scan", which fetch()
 * handles by returning []. This is the neutralization of the old hardcoded
 * personal default — a shared provider must never ship one user's search terms.
 *
 * @param {any} entry
 * @returns {{queries: string[], categories: string[], maxPages: number}}
 */
export function readConfig(entry) {
  const nested = entry && typeof entry.builtin === 'object' && entry.builtin ? entry.builtin : {};
  const arr = (key) => {
    const nv = nested[key];
    if (Array.isArray(nv) && nv.length) return nv.map(String);
    const fv = entry?.[key];
    if (Array.isArray(fv) && fv.length) return fv.map(String);
    return [];
  };
  const rawMax = nested.max_pages ?? entry?.max_pages;
  const maxPages = Math.min(
    HARD_MAX_PAGES,
    Math.max(1, Number.isFinite(rawMax) ? Math.floor(rawMax) : DEFAULT_MAX_PAGES),
  );
  return { queries: arr('queries'), categories: arr('categories'), maxPages };
}

/**
 * Narrow the per-base page cap by ctx.maxPages when the caller is only probing
 * (verify-portals.mjs's health check passes 1).
 *
 * @param {number} entryMax
 * @param {any} ctx
 * @returns {number}
 */
function effectiveMaxPages(entryMax, ctx) {
  const hint = Number(ctx?.maxPages);
  return Number.isFinite(hint) && hint > 0 ? Math.min(entryMax, Math.floor(hint)) : entryMax;
}

/** @type {Provider} */
export default {
  id: 'builtin',

  async fetch(entry, ctx) {
    const { queries, categories, maxPages: entryMax } = readConfig(entry);
    const maxPages = effectiveMaxPages(entryMax, ctx);

    // Build the base paths to paginate: keyword searches + category paths.
    const bases = [
      ...queries.map((q) => `/jobs?search=${encodeURIComponent(q)}`),
      ...categories.map((c) => `/jobs/${encodeURIComponent(c)}`),
    ];

    if (bases.length === 0) {
      // Neutralized default (see readConfig): no personal queries baked in, so
      // an entry with neither queries: nor categories: has nothing to scan.
      console.error(`⚠️  builtin: ${entry?.name ?? 'entry'} has no queries: or categories: — nothing to scan`);
      return [];
    }

    const seen = new Set();
    const out = [];
    for (const base of bases) {
      const sep = base.includes('?') ? '&' : '?';
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://${HOST}${base}${sep}page=${page}`;
        assertHost(url); // SSRF guard before every fetch
        let html;
        try {
          html = /** @type {string} */ (await fetchTextWithRetry(
            /** @type {any} */ (ctx),
            url,
            { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT } },
            RETRY_POLICY,
          ));
        } catch {
          break; // network/HTTP error (e.g. past the last page) — stop this base
        }
        const jobs = parseListPage(html);
        let added = 0;
        for (const j of jobs) {
          if (seen.has(j.url)) continue; // a job can surface across queries/pages
          seen.add(j.url);
          added++;
          out.push(j);
        }
        // No items at all → format changed or past the last page. Items but none
        // NEW → fully-overlapping tail. Either way, stop paginating this base.
        if (jobs.length === 0 || added === 0) break;
      }
    }
    return out;
  },
};
