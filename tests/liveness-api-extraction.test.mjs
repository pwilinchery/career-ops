// tests/liveness-api-extraction.test.mjs — classifyExtractionMethod() / JD_TEXT_API_ATS.
//
// Added 2026-08-31 alongside jd-api-fetch.mjs and browser-extract.mjs's
// fetchJdViaKnownApi(): a batch run that day found every Ashby URL failing JD
// extraction in headless mode even though Ashby's own public API (already used
// for liveness checks) ships the full JD body for free. classifyExtractionMethod()
// is the "does this URL need a browser at all" lookup that fix and
// batch-runner.sh's `--extraction` filter both key off — this file locks its
// classification table so a provider added to ATS_PROVIDERS without a matching
// entry in JD_TEXT_API_ATS (or vice versa) doesn't silently drift the two apart.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const { classifyExtractionMethod, JD_TEXT_API_ATS, resolveAtsApi } =
  await import(pathToFileURL(join(ROOT, 'liveness-api.mjs')).href);

console.log('\nclassifyExtractionMethod()');

function check(desc, condition, details = '') {
  if (condition) pass(desc);
  else fail(`${desc}${details ? ` (${details})` : ''}`);
}

// JD-text-capable ATS -> 'api', ats id populated.
const API_CASES = [
  ['greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/12345'],
  ['lever', 'https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555'],
  ['ashby', 'https://jobs.ashbyhq.com/acme/some-job-id'],
  ['workday', 'https://acme.wd5.myworkdayjobs.com/External/job/Seattle-WA/Engineer_R1234'],
];
for (const [ats, url] of API_CASES) {
  const result = classifyExtractionMethod(url);
  check(`${ats} classifies as 'api'`, result.method === 'api' && result.ats === ats, JSON.stringify(result));
}

// A known ATS with no JD-bearing API (LinkedIn has a liveness rung, not a JD-text
// rung) -> 'browser-required', but ats is still populated so a caller can tell
// "known ATS, just not this kind of API" from "never seen this host before".
{
  const result = classifyExtractionMethod('https://www.linkedin.com/jobs/view/4123456789');
  check(
    'linkedin (known ATS, no JD API) classifies as browser-required with ats set',
    result.method === 'browser-required' && result.ats === 'linkedin',
    JSON.stringify(result),
  );
}

// Microsoft's careers API is search/listing only (no per-job description field),
// and it isn't even in ATS_PROVIDERS (ats stays null) — confirmed live 2026-08-31
// (33/33 extraction failures). Still browser-required either way.
{
  const result = classifyExtractionMethod('https://apply.careers.microsoft.com/careers/job/1970393556944466');
  check(
    'microsoft classifies as browser-required (ats: null — not in ATS_PROVIDERS)',
    result.method === 'browser-required' && result.ats === null,
    JSON.stringify(result),
  );
}

// A totally unrecognized host -> browser-required, ats: null. The conservative
// default: an unknown host might be JS-rendered, so never claim 'api' for it.
{
  const result = classifyExtractionMethod('https://careers.example-totally-unknown-ats.com/jobs/42');
  check(
    'unrecognized host classifies as browser-required with ats: null',
    result.method === 'browser-required' && result.ats === null,
    JSON.stringify(result),
  );
}

// Every id classifyExtractionMethod can emit 'api' for must actually be
// resolvable by resolveAtsApi with that ats id — catches JD_TEXT_API_ATS naming
// a provider id that ATS_PROVIDERS doesn't (or no longer) define.
for (const [ats, url] of API_CASES) {
  const resolved = resolveAtsApi(url);
  check(`${ats}'s API fixture actually resolves via resolveAtsApi`, resolved !== null && resolved.ats === ats, JSON.stringify(resolved));
}

// JD_TEXT_API_ATS membership matches the documented four providers exactly —
// guards against a silent addition/removal that classifyExtractionMethod would
// otherwise pick up without any test noticing the set changed.
check(
  'JD_TEXT_API_ATS is exactly {greenhouse, lever, ashby, workday}',
  JD_TEXT_API_ATS.size === 4 &&
    ['greenhouse', 'lever', 'ashby', 'workday'].every((id) => JD_TEXT_API_ATS.has(id)),
  [...JD_TEXT_API_ATS].join(','),
);
