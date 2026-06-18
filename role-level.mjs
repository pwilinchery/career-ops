#!/usr/bin/env node
/**
 * role-level.mjs — Seniority-level veto for the tracker's title dedup.
 *
 * The tracker dedups by company + fuzzy title match. That match deliberately
 * strips seniority words ("senior", "staff", "II", ...) as stopwords so that
 * "Senior Backend Engineer" and "Backend Engineer, Payments" don't fail to
 * match on noise. The side effect: titles that differ ONLY in level collapse
 * into one row — "SDE II" eats "SDE III", "Senior SWE" eats "Staff SWE".
 *
 * This module is the counterweight. It extracts a level from each title and,
 * when two titles carry CONFLICTING levels, votes 'distinct' — a veto the
 * dedup/merge callers apply exactly like the job-ID veto in job-identity.mjs:
 * it can only BLOCK a merge, never force one. Same-level / unknown → 'unknown'
 * and the caller falls back to the title match alone.
 *
 * Management & exec titles (Manager, Director, VP, Head, Chief, ...) return a
 * null level on purpose: their identity is carried by domain words (Product vs
 * Engineering), the C-suite/VP/Director path already works, and we don't want
 * to touch it. Only the IC seniority ladder is leveled here.
 *
 *   wordRank('Senior Software Engineer')  → 4
 *   wordRank('Staff Software Engineer')   → 5
 *   wordRank('VP of Engineering')         → null  (management — untouched)
 *   numLevels('SDE II')                   → Set {2}
 *   numLevels('SDE III')                  → Set {3}
 *   levelVerdict('Senior SWE', 'Staff SWE') → 'distinct'
 *   levelVerdict('SDE II', 'SDE III')       → 'distinct'
 *   levelVerdict('Backend Eng', 'Backend Developer') → 'unknown'
 */

// Set false to ONLY veto when BOTH titles state a level (Senior vs Staff, II vs
// III). Left true, a bare title ("Software Engineer") counts as mid-level, so
// "Software Engineer" vs "Senior Software Engineer" are also held apart — the
// most common false merge. Flip this if you'd rather risk under-merging a
// cross-listing where one source simply dropped the word "Senior".
export const BARE_IS_A_LEVEL = true;
const BARE_RANK = 3; // a level-less IC title sits at mid on the ladder

// Management / exec markers. A title containing any of these gets NO level
// (wordRank → null), leaving the existing C-suite/VP/Director behaviour intact.
const MGMT_MARKERS = new Set([
  'manager', 'mgr', 'director', 'dir', 'vp', 'svp', 'evp', 'avp',
  'head', 'chief', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'ciso', 'cpo', 'cro', 'cxo',
  'president', 'vice', 'officer', 'partner', 'lead', 'leader', 'supervisor', 'foreman',
]);

// IC seniority ladder → a single rank scale. "senior staff" resolves to the
// most senior marker present (max), so it ranks as staff, not senior.
const WORD_RANK = {
  intern: 1, internship: 1,
  junior: 2, jr: 2, entry: 2, grad: 2, graduate: 2, apprentice: 2, trainee: 2, associate: 2,
  mid: 3, middle: 3, intermediate: 3,
  senior: 4, sr: 4,
  staff: 5,
  principal: 6,
  distinguished: 7, fellow: 7,
};

const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6 };

function tokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-ladder rank for an IC title, or null for management/exec titles (and,
 * when BARE_IS_A_LEVEL is false, for level-less IC titles).
 */
export function wordRank(title) {
  const toks = tokens(title);
  if (toks.length === 0) return null;
  if (toks.some(t => MGMT_MARKERS.has(t))) return null;

  let rank = null;
  for (const t of toks) {
    if (t in WORD_RANK) rank = rank === null ? WORD_RANK[t] : Math.max(rank, WORD_RANK[t]);
  }
  if (rank === null && BARE_IS_A_LEVEL) rank = BARE_RANK;
  return rank;
}

/**
 * Numeric level signals in a title as a Set of integers (empty when none).
 * Catches roman numerals (II/III/IV/VI), explicit codes (L5, IC5, T4,
 * "level 5", "grade 7", "band 4"), and engineering-ladder acronyms glued or
 * spaced to a digit (SDE2, "SWE 3", SDET-2). Single 'i'/'v' are excluded as
 * too noisy (initials, version tags).
 */
export function numLevels(title) {
  const s = String(title || '').toLowerCase();
  const out = new Set();
  // Roman numerals as standalone tokens.
  for (const m of s.matchAll(/\b(ii|iii|iv|vi)\b/g)) out.add(ROMAN[m[1]]);
  // Explicit level codes / words → number.
  for (const m of s.matchAll(/\b(?:level|lvl|grade|band|ic|l|t|e)[\s-]?(\d{1,2})\b/g)) out.add(parseInt(m[1], 10));
  // Engineering-ladder acronym + single digit.
  for (const m of s.matchAll(/\b(?:sdet|swe|sde|sd|mts)[\s-]?(\d)\b/g)) out.add(parseInt(m[1], 10));
  return out;
}

/**
 * Compare two titles by level. Returns 'distinct' when they carry conflicting
 * levels (block the merge) or 'unknown' otherwise (caller falls back to the
 * fuzzy title match). Never returns 'same' — it cannot confirm a merge, only veto.
 */
export function levelVerdict(a, b) {
  // Word ladder: both mapped and ranks differ → distinct.
  const ra = wordRank(a);
  const rb = wordRank(b);
  if (ra !== null && rb !== null && ra !== rb) return 'distinct';

  // Numeric ladder: both carry numeric levels and the sets are disjoint → distinct.
  const na = numLevels(a);
  const nb = numLevels(b);
  if (na.size && nb.size) {
    let shared = false;
    for (const n of na) {
      if (nb.has(n)) { shared = true; break; }
    }
    if (!shared) return 'distinct';
  }

  return 'unknown';
}
