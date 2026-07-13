/**
 * Paylocity ATS adapter.
 *
 * ats_slug format: "{GUID}" (company-specific, found in the careers-page URL)
 * career_url format: "https://recruiting.paylocity.com/recruiting/jobs/All/{GUID}"
 *
 * NOTE: the documented feed API (/recruiting/v2/api/feed/jobs/{guid}) returns an
 * empty 200 for essentially every tenant — it is NOT a block, the endpoint is just
 * dead for public use. The real job list is server-rendered into a `window.pageData`
 * JS blob inside the careers-page HTML. We fetch that page with a browser UA and
 * parse the blob. This is a LIST-ONLY feed (title/location/dept/date) — the blob
 * carries no description; descriptions live on /recruiting/Jobs/Details/{id} and are
 * filled by the generic description backfill.
 */
const logger = require('../logger');

const PAGE_URL = 'https://recruiting.paylocity.com/recruiting/jobs/All';
const PAGEDATA_RE = /window\.pageData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// JobLocation carries the real city/state; LocationName is an internal label
// ("Main", "AVI") used only as a last resort.
function payLocation(j) {
  const loc = j.JobLocation || {};
  const city = loc.City;
  const state = loc.State;
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  return j.LocationName || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 3;

async function fetchJobs(atsSlug) {
  const url = `${PAGE_URL}/${encodeURIComponent(atsSlug)}/`;

  // Paylocity soft-blocks under sustained load: it returns the careers page WITHOUT
  // the window.pageData blob rather than a 429. So we jitter before every attempt and
  // retry the "missing blob" / connection-reset / 429 cases with exponential backoff,
  // exactly like a browser retrying. Only a hard 404/410 (or JobNotFound redirect)
  // means the tenant is really gone.
  let data = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(300 + Math.random() * 1200); // 0.3-1.5s jitter
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
      });
    } catch (e) {
      if (attempt < MAX_RETRIES) { await sleep(2 ** attempt * 1000 + Math.random() * 1000); continue; }
      logger.warn({ atsSlug, err: e.message }, 'Paylocity fetch failed (transient) after retries');
      return { jobs: [], meta: {} };
    }

    if (res.status === 404 || res.status === 410) throw new Error(`Paylocity HTTP ${res.status}`);
    // Redirect to the JobNotFound page = dead tenant (our old numeric slugs) → empty, no retry.
    if (/JobNotFound/i.test(res.url)) return { jobs: [], meta: {} };
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) { await sleep(2 ** attempt * 1000 + Math.random() * 1000); continue; }
      return { jobs: [], meta: {} };
    }
    if (!res.ok) return { jobs: [], meta: {} }; // other 4xx → empty, don't retire

    const html = await res.text();
    const m = PAGEDATA_RE.exec(html);
    if (!m) {
      // Blob missing = soft block → back off and retry; only give up after MAX_RETRIES.
      if (attempt < MAX_RETRIES) { await sleep(2 ** attempt * 1000 + Math.random() * 1000); continue; }
      return { jobs: [], meta: {} };
    }
    try {
      data = JSON.parse(m[1]);
      break;
    } catch {
      if (attempt < MAX_RETRIES) { await sleep(2 ** attempt * 1000 + Math.random() * 1000); continue; }
      logger.warn({ atsSlug }, 'Paylocity: pageData JSON parse failed after retries');
      return { jobs: [], meta: {} };
    }
  }
  if (!data) return { jobs: [], meta: {} };

  const rawJobs = Array.isArray(data.Jobs) ? data.Jobs : [];
  const companyName = data.CompanyName || data.Company || null;

  const jobs = rawJobs.map((job) => {
    const jobId = job.JobId;
    return {
      external_id: `paylocity_${jobId}`,
      title: job.JobTitle || 'Untitled',
      department: job.HiringDepartment || null,
      location: payLocation(job),
      workplace_type: job.IsRemote ? 'remote' : null,
      employment_type: null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: null, // list-only feed; filled by the description backfill
      url: jobId
        ? `https://recruiting.paylocity.com/recruiting/Jobs/Details/${jobId}`
        : url,
      posted_at: job.PublishedDate || null,
      raw_data: job,
    };
  });

  return { jobs, meta: { companyName } };
}

module.exports = { fetchJobs };
