// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Remotive provider — aggregator discovery feed (public JSON, no key).
// Surfaces remote roles across MANY employers, so it has no detect() and is
// reached only via an explicit `provider: remotive` entry in portals.yml.
//
// API: https://remotive.com/api/remote-jobs[?category=<slug>&search=<q>]
//   -> { jobs:[{title, url, company_name, candidate_required_location, ...}],
//        "total-job-count": N, ... }
//
// NOTE: the free API is hard-capped (~30 jobs at check on 2026-06-22); the full
// feed is a paid tier. So this is a LOW-YIELD discovery source. Remotive's terms
// ask us to: hit the endpoint at most a few times a day, link back to the job
// `url` (we use it verbatim, which we do), and not re-syndicate. A single GET per
// scan honors that — do not loop/paginate this provider.

const HOST = 'remotive.com';

function assertHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`remotive: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`remotive: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) throw new Error(`remotive: untrusted hostname "${parsed.hostname}" — must be ${HOST}`);
  return url;
}

/** @type {Provider} */
export default {
  id: 'remotive',

  async fetch(entry, ctx) {
    const params = new URLSearchParams();
    if (entry.category) params.set('category', String(entry.category));
    if (entry.search) params.set('search', String(entry.search));
    const qs = params.toString();
    const url = `https://${HOST}/api/remote-jobs${qs ? `?${qs}` : ''}`;
    assertHost(url);
    const json = await ctx.fetchJson(url, { redirect: 'error' });
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.filter(j => j.url && j.title).map(j => ({
      title: j.title,
      url: j.url,
      company: j.company_name || '',
      location: j.candidate_required_location || '',
    }));
  },
};
