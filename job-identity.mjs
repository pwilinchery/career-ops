#!/usr/bin/env node
/**
 * job-identity.mjs — Stable posting identity from a job URL.
 *
 * The tracker dedups by company + fuzzy role title, which collapses distinct
 * openings that happen to share a title family (e.g. two Greenhouse postings
 * "AI Engineer - FDE" and "Forward Deployed Engineer, Full Stack"). A title
 * alone cannot tell them apart; the stable ID embedded in the URL can.
 *
 * But the URL *string* is not identity either: the same posting is often
 * cross-listed on the company site, the ATS board, and LinkedIn, or pasted in
 * by hand. So we extract the ATS requisition ID and compare those:
 *
 *   - same provider + same ID      → 'same'      (definitely one posting)
 *   - same provider + different ID → 'distinct'  (definitely two postings)
 *   - otherwise                    → 'unknown'   (can't tell — caller falls back)
 *
 * Note Greenhouse `gh_jid` rides along as a query param even on company career
 * pages (e.g. databricks.com/...?gh_jid=NNN and stripe.com/jobs/search?gh_jid=NNN),
 * so a company-site listing and its Greenhouse board entry resolve to the SAME id.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Parse a job URL into { provider, id } or null when no stable ID is found.
 */
export function jobIdentity(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // Greenhouse gh_jid travels on ATS boards AND company career pages — check first
  // so a company-site listing unifies with its Greenhouse board counterpart.
  const ghjid = u.searchParams.get('gh_jid');
  if (ghjid && /^\d+$/.test(ghjid)) return { provider: 'greenhouse', id: ghjid };

  // Greenhouse board path: (job-boards|boards).greenhouse.io/{org}/jobs/{id}
  if (host.endsWith('greenhouse.io')) {
    const m = path.match(/\/jobs\/(\d+)/);
    if (m) return { provider: 'greenhouse', id: m[1] };
  }

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}
  if (host.endsWith('ashbyhq.com')) {
    const m = path.match(UUID);
    if (m) return { provider: 'ashby', id: m[1].toLowerCase() };
  }

  // Lever: jobs.lever.co/{org}/{uuid}
  if (host.endsWith('lever.co')) {
    const m = path.match(UUID);
    if (m) return { provider: 'lever', id: m[1].toLowerCase() };
  }

  // Workday: .../job/.../{title}_{JR####} (req id is the stable part)
  if (host.endsWith('myworkdayjobs.com')) {
    const m = path.match(/(JR-?\d+|R-?\d+)/i) || path.match(/_(\d{4,})(?:-\d+)?(?:\/|$)/);
    if (m) return { provider: 'workday', id: (m[1] || m[0]).replace(/[_/]/g, '').toUpperCase() };
  }

  // Datadog careers detail page (also carries gh_jid, handled above)
  if (host.endsWith('datadoghq.com')) {
    const m = path.match(/\/detail\/(\d+)/);
    if (m) return { provider: 'datadog', id: m[1] };
  }

  return null;
}

/**
 * Compare two job URLs by their stable IDs.
 * Returns 'same' | 'distinct' | 'unknown'.
 */
export function dupeVerdict(urlA, urlB) {
  const a = jobIdentity(urlA);
  const b = jobIdentity(urlB);
  if (a && b && a.provider === b.provider) {
    return a.id === b.id ? 'same' : 'distinct';
  }
  return 'unknown';
}

const _urlCache = new Map();

/**
 * Resolve the `**URL:**` header out of the report file a tracker/TSV row links to.
 * `reportField` is a markdown link like `[291](../reports/291-foo.md)`; `baseDir`
 * is the directory the link is relative to (the tracker file's own dir).
 * Returns the URL string, or null when the link is external/missing/headerless.
 * Results are cached by resolved path.
 */
export function urlFromReport(reportField, baseDir) {
  if (!reportField) return null;
  const m = String(reportField).match(/\]\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].trim();
  if (/^https?:\/\//i.test(p)) return null; // external link, not a local report file
  const full = resolve(baseDir, p);
  if (_urlCache.has(full)) return _urlCache.get(full);
  let url = null;
  try {
    const txt = readFileSync(full, 'utf-8');
    const um = txt.match(/^\*\*URL:\*\*\s*(\S+)/m);
    if (um) url = um[1].trim();
  } catch {
    // report file missing or unreadable — treat as no URL
  }
  _urlCache.set(full, url);
  return url;
}
