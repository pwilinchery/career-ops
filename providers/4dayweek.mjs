// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// 4dayweek.io provider — aggregator discovery feed (public JSON, no key).
// Surfaces roles across MANY employers, not a single tracked company, so it
// has no detect() and is reached only via an explicit `provider: 4dayweek`
// entry in portals.yml. title_filter + location_filter do the culling.
//
// API: https://4dayweek.io/api/jobs?category=<cat>&page=<n>
//   -> { jobs:[{title, slug, company_name, company:{name,hires_worldwide},
//               work_arrangement, locations:[{country,...}], is_expired, ... }],
//        total, page, has_more }
// Canonical posting URL is https://4dayweek.io/jobs/<slug> (verified 2026-06-22).
//
// The feed is large (~18k rows); we fetch a few relevant categories newest-first
// and cap pages per category so a scan stays cheap. Both are overridable per
// portals.yml entry (`categories:` and `max_pages:`).

const HOST = '4dayweek.io';
const PER_PAGE = 25; // server page size (informational)
const DEFAULT_CATEGORIES = ['engineering', 'devops', 'data'];
const DEFAULT_MAX_PAGES = 6; // ~150 newest jobs per category
const HARD_MAX_PAGES = 40; // backstop against a misconfigured entry

function assertHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`4dayweek: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`4dayweek: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) throw new Error(`4dayweek: untrusted hostname "${parsed.hostname}" — must be ${HOST}`);
  return url;
}

// Build a location string the shared location_filter can token-match against.
function locationOf(job) {
  const countries = Array.isArray(job.locations)
    ? [...new Set(job.locations.map(l => l && l.country).filter(Boolean))]
    : [];
  if (job.company && job.company.hires_worldwide) countries.push('Worldwide');
  return countries.join(' | ');
}

/** @type {Provider} */
export default {
  id: '4dayweek',

  async fetch(entry, ctx) {
    const categories = Array.isArray(entry.categories) && entry.categories.length
      ? entry.categories.map(String)
      : DEFAULT_CATEGORIES;
    const maxPages = Math.min(
      HARD_MAX_PAGES,
      Math.max(1, Number.isFinite(entry.max_pages) ? Math.floor(entry.max_pages) : DEFAULT_MAX_PAGES),
    );

    const seen = new Set();
    const out = [];
    for (const category of categories) {
      const cat = encodeURIComponent(category);
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://${HOST}/api/jobs?category=${cat}&page=${page}`;
        assertHost(url);
        const json = await ctx.fetchJson(url, { redirect: 'error' });
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        for (const j of jobs) {
          if (j.is_expired || !j.slug || !j.title) continue;
          if (seen.has(j.slug)) continue; // a job can carry multiple categories
          seen.add(j.slug);
          out.push({
            title: j.title,
            url: `https://${HOST}/jobs/${j.slug}`,
            company: (j.company && j.company.name) || j.company_name || '',
            location: locationOf(j),
          });
        }
        if (!json?.has_more || jobs.length === 0) break;
      }
    }
    return out;
  },
};
