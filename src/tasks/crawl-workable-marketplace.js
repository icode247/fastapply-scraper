/**
 * Crawl jobs.workable.com marketplace API.
 * This is a separate source from apply.workable.com — it's Workable's
 * public job board with 170K+ jobs, full descriptions, and structured data.
 * No proxy needed — clean JSON API.
 */
const { query } = require('../db/connection');
const { classifyJob } = require('../utils/classify');
const logger = require('../logger');

const API_BASE = 'https://jobs.workable.com/api/v1';
const JOBS_PER_PAGE = 20; // API returns 20 per page
// Heroku worker uses the default (500 pages = 10k latest/cycle). A deep local run
// can set MARKETPLACE_MAX_PAGES much higher to walk the full ~170k marketplace.
const MAX_PAGES_PER_CYCLE = parseInt(process.env.MARKETPLACE_MAX_PAGES, 10) || 500;

function mapEmploymentType(type) {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('full')) return 'full_time';
  if (t.includes('part')) return 'part_time';
  if (t.includes('contract')) return 'contract';
  if (t.includes('temporary') || t.includes('temp')) return 'temporary';
  if (t.includes('intern')) return 'internship';
  if (t.includes('freelance')) return 'freelance';
  return null;
}

function buildDescription(job) {
  const parts = [];
  if (job.description) parts.push(job.description);
  if (job.requirementsSection) parts.push(`<h3>Requirements</h3>${job.requirementsSection}`);
  if (job.benefitsSection) parts.push(`<h3>Benefits</h3>${job.benefitsSection}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

function buildLocation(job) {
  if (job.locations && job.locations.length > 0) return job.locations[0];
  if (job.location) {
    const parts = [job.location.city, job.location.subregion, job.location.countryName].filter(Boolean);
    return parts.join(', ') || null;
  }
  return null;
}

async function ensureCompany(companyData) {
  if (!companyData?.id) return null;

  const careerUrl = companyData.url || `https://jobs.workable.com/company/${companyData.id}`;
  const companyName = companyData.title || 'Unknown';
  const domain = companyData.website
    ? companyData.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    : `jobs.workable.com`;
  const logoUrl = companyData.image || null;
  const atsSlug = `wjb_${companyData.id}`;

  // Check if company exists by career_url
  const { rows: existing } = await query(
    'SELECT id FROM companies WHERE career_url = ?',
    [careerUrl]
  );

  if (existing.length > 0) return existing[0].id;

  // Insert new company
  await query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name, logo_url, origin, status, created_at, updated_at)
     VALUES (?, ?, 'workable', ?, ?, ?, 'workable_marketplace', 'active', datetime('now'), datetime('now'))`,
    [careerUrl, domain, atsSlug, companyName, logoUrl]
  );

  // Fetch the inserted ID
  const { rows: inserted } = await query(
    'SELECT id FROM companies WHERE career_url = ?',
    [careerUrl]
  );

  return inserted[0]?.id || null;
}

async function upsertJob(job, companyId) {
  const location = buildLocation(job);
  const description = buildDescription(job);
  const classification = classifyJob({
    title: job.title,
    description,
    location,
    workplace_type: job.workplace || null,
  });

  await query(
    `INSERT INTO jobs (
      external_id, company_id, ats, title, department, location,
      workplace_type, employment_type,
      salary_min, salary_max, salary_currency, salary_interval,
      description, url, posted_at, raw_data,
      visa_sponsorship, experience_level, is_remote, remote_worldwide,
      first_seen_at, last_seen_at
    )
    VALUES (?, ?, 'workable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_id, company_id) DO UPDATE SET
      title = EXCLUDED.title,
      department = EXCLUDED.department,
      location = EXCLUDED.location,
      workplace_type = EXCLUDED.workplace_type,
      employment_type = EXCLUDED.employment_type,
      description = COALESCE(EXCLUDED.description, jobs.description),
      url = EXCLUDED.url,
      posted_at = EXCLUDED.posted_at,
      raw_data = EXCLUDED.raw_data,
      last_seen_at = datetime('now'),
      removed_at = NULL`,
    [
      `workable_mkt_${job.id}`,
      companyId,
      job.title,
      job.department || null,
      location,
      job.workplace || null,
      mapEmploymentType(job.employmentType),
      null, null, null, null, // salary fields — not in marketplace API
      description,
      job.url,
      job.created || null,
      JSON.stringify(job),
      classification.visa_sponsorship || '',
      classification.experience_level || '',
      classification.is_remote || false,
      classification.remote_worldwide || false,
    ]
  );
}

async function crawlWorkableMarketplace() {
  logger.info('Workable marketplace crawl: starting');

  let pageToken = null;
  let totalProcessed = 0;
  let totalAdded = 0;
  let pagesProcessed = 0;
  const companyCache = new Map();

  try {
    while (pagesProcessed < MAX_PAGES_PER_CYCLE) {
      const url = pageToken
        ? `${API_BASE}/jobs?query=&location=&pageToken=${encodeURIComponent(pageToken)}`
        : `${API_BASE}/jobs?query=&location=`;

      // Retry transient failures (a single dropped fetch used to kill the whole
      // deep crawl). Only give up on a page after several backed-off attempts.
      let data = null;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          break;
        } catch (e) {
          if (attempt === 6) { logger.error({ err: e.message, page: pagesProcessed }, 'Workable marketplace: page failed after 6 retries — stopping'); }
          else { await new Promise(r => setTimeout(r, 3000 * attempt)); }
        }
      }
      if (!data) break;
      const jobs = data.jobs || [];

      if (jobs.length === 0) break;

      for (const job of jobs) {
        try {
          // Get or create company
          const companyKey = job.company?.id;
          let companyId = companyCache.get(companyKey);
          if (!companyId && companyKey) {
            companyId = await ensureCompany(job.company);
            if (companyId) companyCache.set(companyKey, companyId);
          }
          if (!companyId) continue;

          await upsertJob(job, companyId);
          totalAdded++;
        } catch (err) {
          logger.debug({ jobId: job.id, err: err.message }, 'Workable marketplace job failed');
        }
        totalProcessed++;
      }

      pagesProcessed++;
      pageToken = data.nextPageToken;

      if (!pageToken) {
        logger.info('Workable marketplace crawl: reached end of results');
        break;
      }

      // Delay to avoid 429 rate limits (1 second between pages)
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Workable marketplace crawl error');
  }

  logger.info({
    pagesProcessed,
    totalProcessed,
    totalAdded,
    companiesCached: companyCache.size,
  }, 'Workable marketplace crawl: complete');

  return totalAdded;
}

module.exports = { crawlWorkableMarketplace };

// Standalone deep run: MARKETPLACE_MAX_PAGES=8500 walks the full ~170k marketplace.
if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  crawlWorkableMarketplace()
    .then((added) => { console.log('Workable marketplace crawl finished — jobs upserted:', added); process.exit(0); })
    .catch((e) => { console.error('FATAL', e); process.exit(1); });
}
