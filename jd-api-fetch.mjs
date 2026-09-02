#!/usr/bin/env node
/**
 * jd-api-fetch.mjs — bash-callable front door to fetchJdViaKnownApi().
 *
 * batch-runner.sh's per-offer prefetch (process_offer) currently only knows
 * one extraction method: curl the posting URL and strip HTML tags. That works
 * for server-rendered boards, but returns near-empty text — correctly detected
 * as "thin" and discarded — for JS-rendered ATS pages (Ashby, Microsoft),
 * which then fall through to the worker's own WebFetch, which hits the same
 * unrendered shell and fails the same way. Confirmed 2026-08-31: every Ashby
 * URL in that day's batch failed extraction even though Ashby's own public API
 * (used for liveness checks already) ships the full JD body for free.
 *
 * This script tries that API path FIRST, from bash, before the curl fallback:
 *
 *   node jd-api-fetch.mjs <url>              JD text on stdout, exit 0 on hit;
 *                                             exit 1 silently (no stderr noise)
 *                                             when there's no API text — the
 *                                             caller's existing curl fallback
 *                                             is the intended next step, not
 *                                             an error condition.
 *   node jd-api-fetch.mjs --classify <url>   {"method":"api"|"browser-required",
 *                                             "ats":"greenhouse"|null} on
 *                                             stdout, exit 0 always. For a
 *                                             caller deciding whether a URL
 *                                             belongs in a headless run before
 *                                             touching it at all (batch-runner.sh
 *                                             --extraction filter).
 *
 * One routing table, shared with the interactive path: both this script and
 * browser-extract.mjs's jd mode call the exact same fetchJdViaKnownApi() /
 * classifyExtractionMethod(), so batch and interactive can never disagree on
 * which ATS is API-fetchable.
 */

import { fetchJdViaKnownApi } from './browser-extract.mjs';
import { classifyExtractionMethod } from './liveness-api.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TEXT_CAP = 20_000; // batch reports read the full JD; no token-budget reason to cap tighter here
const TIMEOUT_MS = 15_000;

async function main() {
  const args = process.argv.slice(2);
  const classifyIdx = args.indexOf('--classify');
  const classify = classifyIdx !== -1;
  if (classify) args.splice(classifyIdx, 1);
  const url = args[0];

  if (!url) {
    console.error('usage: node jd-api-fetch.mjs [--classify] <url>');
    process.exit(1);
  }

  if (classify) {
    // Always exits 0 — this is a lookup, not a fetch; "browser-required" is a
    // valid, successful answer, not a failure.
    console.log(JSON.stringify(classifyExtractionMethod(url)));
    return;
  }

  const result = await fetchJdViaKnownApi(url, TEXT_CAP, TIMEOUT_MS);
  if (!result) process.exit(1); // no stderr: this is the expected "fall through to curl" case

  const header = result.title ? `${result.title}\n\n` : '';
  process.stdout.write(header + result.text);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`jd-api-fetch: unexpected error — ${err?.message || err}`);
    process.exit(1);
  });
}
