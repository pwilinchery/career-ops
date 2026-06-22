// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Arbeitnow provider — aggregator discovery feed (public JSON, no key).
// EU + remote job-board API spanning MANY employers, so it has no detect() and
// is reached only via an explicit `provider: arbeitnow` entry in portals.yml.
// It skews European; the shared location_filter culls to English-market roles.
//
// API: https://www.arbeitnow.com/api/job-board-api[?search=<q>]
//   -> { data:[{title, url, company_name, location, remote, slug, ...}],
//        links:{ next:<url|null> }, meta:{...} }
// Paginated (~100/page) via links.next. We cap pages so a scan stays cheap;
// override with `max_pages:` and pre-filter with `search:` in portals.yml.

const HOST = 'www.arbeitnow.com';
const DEFAULT_MAX_PAGES = 5; // ~500 newest rows
const HARD_MAX_PAGES = 30;

function assertHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`arbeitnow: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`arbeitnow: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) throw new Error(`arbeitnow: untrusted hostname "${parsed.hostname}" — must be ${HOST}`);
  return url;
}

/** @type {Provider} */
export default {
  id: 'arbeitnow',

  async fetch(entry, ctx) {
    const maxPages = Math.min(
      HARD_MAX_PAGES,
      Math.max(1, Number.isFinite(entry.max_pages) ? Math.floor(entry.max_pages) : DEFAULT_MAX_PAGES),
    );
    const params = new URLSearchParams();
    if (entry.search) params.set('search', String(entry.search));
    const qs = params.toString();
    let next = `https://${HOST}/api/job-board-api${qs ? `?${qs}` : ''}`;

    const seen = new Set();
    const out = [];
    for (let page = 0; page < maxPages && next; page++) {
      assertHost(next);
      const json = await ctx.fetchJson(next, { redirect: 'error' });
      const rows = Array.isArray(json?.data) ? json.data : [];
      for (const j of rows) {
        if (!j.url || !j.title || seen.has(j.url)) continue;
        seen.add(j.url);
        const remoteTag = j.remote ? 'Remote' : '';
        out.push({
          title: j.title,
          url: j.url,
          company: j.company_name || '',
          location: [j.location, remoteTag].filter(Boolean).join(' | '),
        });
      }
      next = (json && json.links && json.links.next) || null;
    }
    return out;
  },
};
