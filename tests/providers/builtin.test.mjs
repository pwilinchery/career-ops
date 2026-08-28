// tests/providers/builtin.test.mjs — contract test for the builtin.com
// aggregator provider. Auto-discovered by test-all.mjs under tests/**.
// Run alone with: node test-all.mjs --only providers/builtin
//
// Every fixture here is synthetic. Nothing in this file touches the network.

import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — builtin');

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const HOST = 'builtin.com';

// Build one ItemList entry exactly as builtin embeds it (stable key order).
const item = (name, url, description) =>
  `{"@type":"ListItem","position":1,"name":${JSON.stringify(name)},"url":${JSON.stringify(url)}`
  + (description !== undefined ? `,"description":${JSON.stringify(description)}` : '')
  + '}';
const pageHtml = (items) => `<html><body><script>{"itemListElement":[${items.join(',')}]}</script></body></html>`;

// A ctx recording every fetchText(url, opts). Replays canned HTML keyed by URL;
// an Error value is thrown; an unknown URL returns '' (an empty page → stop).
function mockCtx(pages) {
  const calls = [];
  return {
    calls,
    ctx: {
      transport: 'http',
      fetchJson: async () => ({}),
      sleep: async () => {},
      fetchText: async (url, opts) => {
        calls.push({ url, opts });
        const v = pages[url];
        if (v instanceof Error) throw v;
        return v ?? '';
      },
    },
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/builtin.mjs')).href);
  const bi = mod.default;
  const { parseListPage, readConfig } = mod;

  // ── id / no detect ──────────────────────────────────────────────────
  if (bi.id === 'builtin') pass('builtin.id is "builtin"');
  else fail(`builtin.id is ${JSON.stringify(bi.id)}`);

  if (typeof bi.detect === 'undefined') {
    pass('builtin has no detect() — it is an explicit provider:builtin-only aggregator');
  } else {
    fail('builtin should not expose detect() (explicit-only)');
  }

  // ── readConfig ──────────────────────────────────────────────────────
  const dflt = readConfig({ name: 'B' });
  if (dflt.queries.length === 0 && dflt.categories.length === 0 && dflt.maxPages === 3) {
    pass('readConfig() ships NO default queries (neutralized) and defaults max_pages to 3');
  } else {
    fail(`readConfig(default) = ${JSON.stringify(dflt)}`);
  }

  const flat = readConfig({ queries: ['platform engineer'], categories: ['dev-engineering'], max_pages: 2 });
  if (flat.queries.join() === 'platform engineer' && flat.categories.join() === 'dev-engineering' && flat.maxPages === 2) {
    pass('readConfig() honours legacy-flat queries/categories/max_pages');
  } else {
    fail(`readConfig(flat) = ${JSON.stringify(flat)}`);
  }

  const nested = readConfig({ queries: ['flat-loses'], builtin: { queries: ['nested-wins'], max_pages: 4 } });
  if (nested.queries.join() === 'nested-wins' && nested.maxPages === 4) {
    pass('readConfig() lets the nested builtin:{} block win over flat keys');
  } else {
    fail(`readConfig(nested) = ${JSON.stringify(nested)}`);
  }

  const clampHi = readConfig({ queries: ['x'], max_pages: 999 });
  const clampLo = readConfig({ queries: ['x'], max_pages: 0 });
  if (clampHi.maxPages === 25 && clampLo.maxPages === 1) {
    pass('readConfig() clamps max_pages to [1, 25]');
  } else {
    fail(`clamp: hi=${clampHi.maxPages} lo=${clampLo.maxPages} (expected 25 / 1)`);
  }

  // ── parseListPage (pure) ────────────────────────────────────────────
  const html = pageHtml([
    item('Platform Engineer', 'https://builtin.com/job/1', 'Own the platform.'),
    item('Backend Engineer', 'https://builtin.com/job/2'),          // no description
    '{"@type":"ListItem","position":3,"name":"Broken}',              // malformed → skipped
    item('', 'https://builtin.com/job/4', 'no title'),              // no title → dropped
  ]);
  const parsed = parseListPage(html);
  if (parsed.length === 2) {
    pass('parseListPage() parses valid ItemList rows and skips malformed / titleless ones (2 kept)');
  } else {
    fail(`parseListPage kept ${parsed.length}: ${JSON.stringify(parsed.map((j) => j.title))}`);
  }
  if (parsed[0]?.title === 'Platform Engineer' && parsed[0]?.url === 'https://builtin.com/job/1'
      && parsed[0]?.description === 'Own the platform.' && parsed[0]?.company === '' && parsed[0]?.location === '') {
    pass('parseListPage() maps title/url/description and leaves company/location empty by design');
  } else {
    fail(`row 0 mapping: ${JSON.stringify(parsed[0])}`);
  }
  if (parsed[1]?.description === '') {
    pass('parseListPage() defaults a missing description to ""');
  } else {
    fail(`missing-description row: ${JSON.stringify(parsed[1])}`);
  }
  if (parseListPage(null).length === 0 && parseListPage(42).length === 0 && parseListPage('<html></html>').length === 0) {
    pass('parseListPage() returns [] for non-string / itemless input (no crash)');
  } else {
    fail('parseListPage() should return [] for degenerate input');
  }

  // ── fetch: NEUTRALIZATION (the whole point of the rebuild) ───────────
  const noCfg = mockCtx({});
  const nothing = await bi.fetch({ name: 'BuiltIn' }, noCfg.ctx);
  if (Array.isArray(nothing) && nothing.length === 0 && noCfg.calls.length === 0) {
    pass('builtin.fetch() with NO queries/categories returns [] and makes ZERO requests (no baked-in personal defaults)');
  } else {
    fail(`neutralization: ${nothing.length} jobs in ${noCfg.calls.length} requests (expected 0 / 0)`);
  }

  // ── fetch: URL construction, headers, host pin ──────────────────────
  const q = encodeURIComponent('platform engineer');
  const searchP1 = `https://builtin.com/jobs?search=${q}&page=1`;
  const catP1 = 'https://builtin.com/jobs/dev-engineering?page=1';
  const built = mockCtx({
    [searchP1]: pageHtml([item('Platform Engineer', 'https://builtin.com/job/1', 'x')]),
    [catP1]: pageHtml([item('Dev Eng', 'https://builtin.com/job/9', 'y')]),
  });
  const jobsBuilt = await bi.fetch(
    { name: 'BuiltIn', queries: ['platform engineer'], categories: ['dev-engineering'], max_pages: 1 },
    built.ctx,
  );
  if (built.calls.some((c) => c.url === searchP1) && built.calls.some((c) => c.url === catP1) && jobsBuilt.length === 2) {
    pass('builtin.fetch() builds /jobs?search=&page= and /jobs/<category>?page= URLs');
  } else {
    fail(`URL construction: ${built.calls.map((c) => c.url).join(' | ')} → ${jobsBuilt.length} jobs`);
  }
  if (built.calls.every((c) => c.opts?.redirect === 'error' && c.opts?.headers?.['User-Agent'])) {
    pass('builtin.fetch() passes redirect:"error" + a browser UA on every request');
  } else {
    fail(`fetch opts: ${JSON.stringify(built.calls.map((c) => c.opts))}`);
  }
  if (built.calls.every((c) => hostOf(c.url) === HOST)) {
    pass('builtin.fetch() only ever requests builtin.com');
  } else {
    fail(`hosts requested: ${built.calls.map((c) => hostOf(c.url)).join(',')}`);
  }

  // ── fetch: dedup across pages, stop on empty page ───────────────────
  const p1 = `https://builtin.com/jobs?search=a&page=1`;
  const p2 = `https://builtin.com/jobs?search=a&page=2`;
  const p3 = `https://builtin.com/jobs?search=a&page=3`;
  const dedupCtx = mockCtx({
    [p1]: pageHtml([item('X', 'https://builtin.com/job/x', 'x'), item('Y', 'https://builtin.com/job/y', 'y')]),
    [p2]: pageHtml([item('Y', 'https://builtin.com/job/y', 'y'), item('Z', 'https://builtin.com/job/z', 'z')]), // Y dup, Z new
    [p3]: '', // empty → stop
  });
  const deduped = await bi.fetch({ name: 'B', queries: ['a'], max_pages: 5 }, dedupCtx.ctx);
  if (deduped.length === 3 && new Set(deduped.map((j) => j.url)).size === 3) {
    pass('builtin.fetch() dedupes the same url across pages (X,Y,Z from an overlapping page 2)');
  } else {
    fail(`dedup: ${deduped.length} jobs (${deduped.map((j) => j.title).join(',')})`);
  }
  if (dedupCtx.calls.length === 3) {
    pass('builtin.fetch() stops paginating a base once a page yields no NEW items / is empty');
  } else {
    fail(`pagination stop: ${dedupCtx.calls.length} requests (expected 3)`);
  }

  // ── fetch: ctx.maxPages probe hint narrows to 1 page per base ────────
  const probeCtx = mockCtx({
    [p1]: pageHtml([item('X', 'https://builtin.com/job/x', 'x')]),
    [p2]: pageHtml([item('W', 'https://builtin.com/job/w', 'w')]),
  });
  await bi.fetch({ name: 'B', queries: ['a'], max_pages: 5 }, { ...probeCtx.ctx, maxPages: 1 });
  if (probeCtx.calls.length === 1) {
    pass('builtin.fetch() honors the ctx.maxPages probe hint (1 page per base)');
  } else {
    fail(`ctx.maxPages hint: ${probeCtx.calls.length} requests (expected 1)`);
  }

  // ── fetch: a throwing page ends that base without crashing ──────────
  const goodP1 = `https://builtin.com/jobs?search=good&page=1`;
  const goodP2 = `https://builtin.com/jobs?search=good&page=2`;
  const badP1 = `https://builtin.com/jobs?search=bad&page=1`;
  const throwCtx = mockCtx({
    [goodP1]: pageHtml([item('Good Role', 'https://builtin.com/job/g', 'g')]),
    [goodP2]: '', // stop good base
    [badP1]: new Error('boom'),
  });
  const survived = await bi.fetch({ name: 'B', queries: ['good', 'bad'], max_pages: 3 }, throwCtx.ctx);
  if (survived.length === 1 && survived[0]?.title === 'Good Role') {
    pass('builtin.fetch() keeps a good base and swallows a throwing base without crashing');
  } else {
    fail(`throw handling: ${JSON.stringify(survived.map((j) => j.title))}`);
  }
} catch (e) {
  fail(`builtin provider tests crashed: ${e.message}`);
}
