// tests/providers/microsoft.test.mjs — contract test for the Microsoft PCS-X
// provider. Auto-discovered by test-all.mjs under tests/**; no registration.
// Run alone with: node test-all.mjs --only providers/microsoft
//
// Every fixture here is synthetic. Nothing in this file touches the network.

import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — microsoft');

// Validate URLs by PARSED hostname, never by substring — a trusted host
// fragment can hide in a hostile URL's path/query/userinfo.
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };

const API_HOST = 'apply.careers.microsoft.com';

// A ctx that records every URL + options and replays canned pages keyed by the
// `start` offset. Response shape mirrors the live API: { data: { positions, count } }.
function mockCtx(pages) {
  const calls = [];
  return {
    calls,
    ctx: {
      transport: 'http',
      fetchText: async () => '',
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        calls.push({ url, opts });
        const start = Number(new URL(url).searchParams.get('start') || '0');
        return pages[start] ?? { data: { positions: [], count: 0 } };
      },
    },
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/microsoft.mjs')).href);
  const ms = mod.default;
  const { readSearchConfig, buildApiUrl, parseMicrosoftResponse } = mod;

  // ── id ──────────────────────────────────────────────────────────────
  if (ms.id === 'microsoft') pass('microsoft.id is "microsoft"');
  else fail(`microsoft.id is ${JSON.stringify(ms.id)}`);

  // ── detect ──────────────────────────────────────────────────────────
  const hit = ms.detect({ name: 'Microsoft', careers_url: 'https://jobs.careers.microsoft.com/global/en/search' });
  if (hit && hostOf(hit.url) === API_HOST && new URL(hit.url).pathname === '/api/pcsx/search') {
    pass('microsoft.detect() claims a *.careers.microsoft.com careers_url and pins the API host');
  } else {
    fail(`microsoft.detect() returned ${JSON.stringify(hit)}`);
  }

  const exact = ms.detect({ name: 'MS', careers_url: 'https://careers.microsoft.com/us/en' });
  if (exact && hostOf(exact.url) === API_HOST) pass('microsoft.detect() accepts the apex careers.microsoft.com');
  else fail(`microsoft.detect(apex) returned ${JSON.stringify(exact)}`);

  // ── detect: SSRF / negative pin ─────────────────────────────────────
  // The host regex is anchored on a dot boundary, so a lookalike prefix host
  // (evilcareers.microsoft.com) and any non-Microsoft host must return null.
  const badEntries = [
    { name: 'B', careers_url: 'https://evilcareers.microsoft.com/jobs' }, // lookalike prefix (bare endsWith would accept this)
    { name: 'B', careers_url: 'https://careers.microsoft.com.evil.example/jobs' }, // suffix lookalike
    { name: 'B', careers_url: 'https://evil.example/careers.microsoft.com/jobs' }, // trusted host in the path
    { name: 'B', careers_url: 'https://careers.microsoft.com@evil.example/jobs' }, // trusted host in userinfo
    { name: 'B', careers_url: 'https://www.google.com/about/careers' },
    {}, { name: 'B' }, { name: 'B', careers_url: null }, { name: 'B', careers_url: 42 },
    { name: 'B', careers_url: 'not a url' },
  ];
  const leaks = badEntries.filter((e) => ms.detect(e) !== null);
  if (leaks.length === 0) {
    pass(`microsoft.detect() returns null for all ${badEntries.length} untrusted / unusable entries`);
  } else {
    fail(`microsoft.detect() accepted: ${leaks.map((e) => e.careers_url).join(' | ')}`);
  }

  // ── readSearchConfig ────────────────────────────────────────────────
  const dflt = readSearchConfig({ name: 'MS' });
  if (dflt.query === 'software engineer' && dflt.location === '') {
    pass('readSearchConfig() defaults query to "software engineer" and location to unset');
  } else {
    fail(`readSearchConfig(default) = ${JSON.stringify(dflt)}`);
  }

  const flat = readSearchConfig({ query: 'backend engineer', location: 'Redmond' });
  if (flat.query === 'backend engineer' && flat.location === 'Redmond') {
    pass('readSearchConfig() honours legacy-flat query/location');
  } else {
    fail(`readSearchConfig(flat) = ${JSON.stringify(flat)}`);
  }

  const nested = readSearchConfig({ query: 'backend engineer', microsoft: { query: 'ml engineer', location: 'Dublin' } });
  if (nested.query === 'ml engineer' && nested.location === 'Dublin') {
    pass('readSearchConfig() lets the nested microsoft:{} block win over flat keys');
  } else {
    fail(`readSearchConfig(nested) = ${JSON.stringify(nested)}`);
  }

  // ── buildApiUrl ─────────────────────────────────────────────────────
  const u = buildApiUrl({ query: 'backend engineer', location: 'Redmond' }, 20);
  const up = new URL(u).searchParams;
  if (hostOf(u) === API_HOST && up.get('domain') === 'microsoft.com'
      && up.get('query') === 'backend engineer' && up.get('location') === 'Redmond' && up.get('start') === '20') {
    pass('buildApiUrl() sets domain/query/location/start on the pinned host');
  } else {
    fail(`buildApiUrl() = ${u}`);
  }
  if (!new URL(buildApiUrl({ query: 'x', location: '' }, 0)).searchParams.has('location')) {
    pass('buildApiUrl() omits location= when unset');
  } else {
    fail('buildApiUrl() should omit an empty location=');
  }

  // ── parseMicrosoftResponse (pure) ───────────────────────────────────
  const fixture = {
    data: {
      count: 8,
      positions: [
        // 0: full row, absolute positionUrl (display-only, host not pinned), standardizedLocations, postedTs SECONDS
        { id: 5001, name: 'Senior Software Engineer', positionUrl: 'https://jobs.careers.microsoft.com/global/en/job/5001/sse', standardizedLocations: ['Redmond, WA, US'], locations: ['Redmond, Washington, United States'], postedTs: 1_780_000_000 },
        // 1: no positionUrl → tenant fallback built from id; plain locations only
        { id: 5002, name: 'Principal PM', locations: ['Dublin, Ireland'] },
        // 2: DROP — no title
        { id: 5003, positionUrl: '/careers/job/5003' },
        // 3: DROP — title but no id (nothing stable to key on)
        { name: 'Ghost Role', positionUrl: 'https://jobs.careers.microsoft.com/x' },
        // 4: relative positionUrl → prefixed to the API host; duplicate standardizedLocations deduped
        { id: 5005, name: 'Data Engineer', positionUrl: '/global/en/job/5005/de', standardizedLocations: ['Atlanta, GA, US', 'Atlanta, GA, US'] },
        // 5: not an object
        null,
      ],
    },
  };
  const parsed = parseMicrosoftResponse(fixture, 'Microsoft');

  if (parsed.length === 3) {
    pass('parseMicrosoftResponse() drops rows with no title / no id (6 in → 3 out)');
  } else {
    fail(`drop rules: expected 3, got ${parsed.length}: ${JSON.stringify(parsed.map((j) => j.title))}`);
  }

  const first = parsed[0];
  if (first?.title === 'Senior Software Engineer'
      && first.url === 'https://jobs.careers.microsoft.com/global/en/job/5001/sse'
      && first.company === 'Microsoft'
      && first.location === 'Redmond, WA, US'
      && first.postedAt === 1_780_000_000_000) {
    pass('parseMicrosoftResponse() maps title/url/company, prefers standardizedLocations, converts postedTs (s→ms)');
  } else {
    fail(`row 0 mapping: ${JSON.stringify(first)}`);
  }

  if (parsed[1]?.url === `https://${API_HOST}/careers/job/5002` && parsed[1]?.location === 'Dublin, Ireland' && parsed[1]?.postedAt === undefined) {
    pass('parseMicrosoftResponse() builds the /careers/job/<id> fallback URL and omits postedAt when undated');
  } else {
    fail(`row 1 fallback: ${JSON.stringify(parsed[1])}`);
  }

  if (parsed[2]?.url === `https://${API_HOST}/global/en/job/5005/de` && parsed[2]?.location === 'Atlanta, GA, US') {
    pass('parseMicrosoftResponse() prefixes a relative positionUrl to the API host and dedupes locations');
  } else {
    fail(`row 4 relative-url: ${JSON.stringify(parsed[2])}`);
  }

  // Degenerate payloads must return [] rather than throw.
  const degenerate = [null, undefined, {}, [], 'nope', { data: null }, { data: {} }, { data: { positions: null } }];
  if (degenerate.every((j) => {
    const r = parseMicrosoftResponse(j, 'X');
    return Array.isArray(r) && r.length === 0;
  })) {
    pass('parseMicrosoftResponse() returns [] for null/{}/[]/non-array payloads (no crash)');
  } else {
    fail('parseMicrosoftResponse() should return [] for degenerate payloads');
  }

  // ── fetch: pagination, redirect:"error", headers, host pin ──────────
  const full = (n, offset) => Array.from({ length: n }, (_, i) => ({
    id: offset + i, name: `Role ${offset + i}`, standardizedLocations: ['Redmond, WA, US'],
  }));
  const { calls, ctx } = mockCtx({
    0: { data: { count: 25, positions: full(10, 0) } },
    10: { data: { count: 25, positions: full(10, 10) } },
    20: { data: { count: 25, positions: full(5, 20) } }, // short page → stop
  });
  const entry = { name: 'Microsoft', careers_url: 'https://jobs.careers.microsoft.com/global/en/search' };
  const jobs = await ms.fetch(entry, ctx);

  if (calls.length === 3 && jobs.length === 25) {
    pass('microsoft.fetch() paginates by start= and aggregates (3 pages → 25 jobs)');
  } else {
    fail(`pagination: ${calls.length} requests, ${jobs.length} jobs (expected 3 / 25)`);
  }

  if (calls.every((c) => c.opts?.redirect === 'error')) {
    pass('microsoft.fetch() passes redirect:"error" on every page (SSRF via redirect)');
  } else {
    fail(`redirect option: ${JSON.stringify(calls.map((c) => c.opts?.redirect))}`);
  }

  if (calls.every((c) => c.opts?.headers?.['User-Agent'] && c.opts.headers.Accept === 'application/json')) {
    pass('microsoft.fetch() sends browser UA + Accept: application/json');
  } else {
    fail(`fetch headers = ${JSON.stringify(calls[0]?.opts?.headers)}`);
  }

  if (calls.every((c) => hostOf(c.url) === API_HOST)) {
    pass('microsoft.fetch() only ever requests the pinned API host');
  } else {
    fail(`hosts requested: ${calls.map((c) => hostOf(c.url)).join(',')}`);
  }

  // An empty board is a valid answer, not an error.
  const empty = mockCtx({ 0: { data: { count: 0, positions: [] } } });
  const none = await ms.fetch(entry, empty.ctx);
  if (Array.isArray(none) && none.length === 0 && empty.calls.length === 1) {
    pass('microsoft.fetch() returns [] after a single request for an empty board');
  } else {
    fail(`empty board: ${none.length} jobs in ${empty.calls.length} requests`);
  }

  // max_pages caps the loop even when the board claims more.
  const bigPages = {};
  for (let s = 0; s <= 500; s += 10) bigPages[s] = { data: { count: 500, positions: full(10, s) } };
  const capped = mockCtx(bigPages);
  const cappedJobs = await ms.fetch({ ...entry, max_pages: 4 }, capped.ctx);
  if (capped.calls.length === 4 && cappedJobs.length === 40) {
    pass('microsoft.fetch() honors max_pages on the entry (4 pages → 40 jobs)');
  } else {
    fail(`max_pages: ${capped.calls.length} requests, ${cappedJobs.length} jobs (expected 4 / 40)`);
  }

  // ctx.maxPages is verify-portals.mjs's health-probe hint — it must narrow further.
  const probe = mockCtx(bigPages);
  await ms.fetch(entry, { ...probe.ctx, maxPages: 1 });
  if (probe.calls.length === 1) {
    pass('microsoft.fetch() honors the ctx.maxPages probe hint (1 page)');
  } else {
    fail(`ctx.maxPages hint: ${probe.calls.length} requests (expected 1)`);
  }

  // A non-Microsoft entry must throw BEFORE any network call.
  let touched = false;
  try {
    await ms.fetch(
      { name: 'BadCo', careers_url: 'https://example.com/careers' },
      { transport: 'http', fetchText: async () => '', fetchJson: async () => { touched = true; return {}; } },
    );
    fail('microsoft.fetch() should throw for a non-Microsoft entry');
  } catch (e) {
    if (/not a \*\.careers\.microsoft\.com/.test(e.message) && !touched) {
      pass('microsoft.fetch() throws before any request for a non-Microsoft entry');
    } else {
      fail(`unexpected fetch error / fetchJson called=${touched}: ${e.message}`);
    }
  }
} catch (e) {
  fail(`microsoft provider tests crashed: ${e.message}`);
}
