#!/usr/bin/env node
/**
 * Standalone one-shot company sync — the de-BullMQ replacement for the Heroku worker's
 * fanout+queue. Claims the due company set (optionally sharded by `id % SHARD_COUNT` so
 * parallel GitHub-Actions runners never overlap), crawls each company via its ATS adapter,
 * upserts jobs, bumps last_synced_at, then exits. No Redis, no queue — all state is
 * companies.last_synced_at in Postgres, so recomputing the due-set each run is safe.
 *
 * Body ported verbatim from src/queues/sync.queue.js (the BullMQ worker processor).
 *
 * Usage:  node sync-once.js --shard 0 --shard-count 16 --limit 5000
 * Env:    DATABASE_URL (required), CONCURRENCY (default 10), DRY_RUN=1 (fetch+classify, no writes)
 */
const { companiesRepo, jobsRepo, closeDb } = require('./src/db');
const { getAdapter } = require('./src/adapters');
const { fetchLogoUrl } = require('./src/adapters/logo');
const logger = require('./src/logger');
const { extractSalary, extractWorkplaceType, extractEmploymentType } = require('./src/utils/extract');
const { stripHtml } = require('./src/utils/html');
const { classifyJob } = require('./src/utils/classify');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const SHARD = parseInt(arg('shard', process.env.SHARD || '0'), 10);
const SHARD_COUNT = parseInt(arg('shard-count', process.env.SHARD_COUNT || '1'), 10);
const LIMIT = parseInt(arg('limit', process.env.LIMIT || '1500'), 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const DRY_RUN = process.env.DRY_RUN === '1';

// Per-ATS concurrency caps + post-delay — copied verbatim from sync.queue.js:16-43.
const ATS_MAX_CONCURRENT = { workable: 1, recruitee: 3, workday: 2, lever: 2, icims: 3, oracle: 2, breezy: 3, zoho: 2, successfactors: 2, paylocity: 3 };
const ATS_POST_DELAY = { workable: 5000 };
const atsConcurrency = {};
function acquireAtsSlot(ats) {
  if (!ATS_MAX_CONCURRENT[ats]) return true;
  atsConcurrency[ats] = atsConcurrency[ats] || 0;
  if (atsConcurrency[ats] >= ATS_MAX_CONCURRENT[ats]) return false;
  atsConcurrency[ats]++;
  return true;
}
function releaseAtsSlot(ats) {
  if (!ATS_MAX_CONCURRENT[ats]) return;
  atsConcurrency[ats] = Math.max(0, (atsConcurrency[ats] || 0) - 1);
}
function waitForAtsSlot(ats, interval = 500) {
  if (!ATS_MAX_CONCURRENT[ats]) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => { if (acquireAtsSlot(ats)) return resolve(); setTimeout(check, interval); };
    check();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One company sync — mirrors sync.queue.js:60-150.
async function syncCompany({ id: companyId, ats, ats_slug: atsSlug }) {
  await waitForAtsSlot(ats);
  const adapter = getAdapter(ats);
  try {
    const result = await adapter.fetchJobs(atsSlug);
    const incomingJobs = result.jobs || result;
    const meta = result.meta || {};

    // Enrich each job (salary/workplace/employment + classification) exactly as the worker did.
    for (const job of incomingJobs) {
      const plainDesc = job.description ? stripHtml(job.description) : null;
      if (!job.salary_min && plainDesc) {
        const salary = extractSalary(plainDesc);
        if (salary) { job.salary_min = salary.min; job.salary_max = salary.max; job.salary_currency = salary.currency; job.salary_interval = salary.interval; }
      }
      if (!job.workplace_type) job.workplace_type = extractWorkplaceType(job.title, job.location, plainDesc);
      if (!job.employment_type) job.employment_type = extractEmploymentType(job.title, plainDesc);
      const tags = classifyJob(job);
      job.is_remote = tags.is_remote;
      job.remote_worldwide = tags.remote_worldwide;
      job.experience_level = tags.experience_level;
    }

    if (DRY_RUN) return { added: 0, removed: 0, dryRun: incomingJobs.length };

    // Company meta (name + logo) — same fallbacks as sync.queue.js:77-106.
    const company = await companiesRepo.findById(companyId);
    if (adapter.fetchCompanyMeta) {
      try {
        const am = await adapter.fetchCompanyMeta(atsSlug);
        if (am) { meta.companyName = meta.companyName || am.companyName; if (am.logoUrl) meta.logoUrl = am.logoUrl; }
      } catch { /* meta is best-effort */ }
    }
    if (!meta.companyName && atsSlug) meta.companyName = atsSlug.charAt(0).toUpperCase() + atsSlug.slice(1);
    if (!meta.logoUrl) {
      const needs = !company?.logo_url
        || company.logo_url.includes('clearbit.com')
        || company.logo_url.includes('sr-company-logo-prod')
        || company.logo_url.includes('gstatic.com/faviconV2');
      if (needs) meta.logoUrl = await fetchLogoUrl(ats, atsSlug, company?.domain);
    }
    await companiesRepo.updateMeta(companyId, meta);

    const diff = await jobsRepo.syncForCompany(companyId, ats, incomingJobs);
    await companiesRepo.updateLastSynced(companyId);
    return diff;
  } finally {
    releaseAtsSlot(ats);
    if (ATS_POST_DELAY[ats]) await sleep(ATS_POST_DELAY[ats]);
  }
}

// Retry wrapper — replaces BullMQ attempts:5/backoff + the 'failed' handler (sync.queue.js:48-53,162-170).
async function syncWithRetry(company) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await syncCompany(company);
    } catch (e) {
      const msg = String(e.message || '');
      // 4xx (except 429) is deterministic — a dead/missing tenant. Don't waste retries;
      // fail fast so the run doesn't crawl to a halt on dead slugs. 429/5xx/network = retry.
      const dead4xx = /\b(400|401|403|404|410)\b/.test(msg) || (/HTTP 4\d\d/.test(msg) && !msg.includes('429'));
      if (attempt < maxAttempts && !dead4xx) { await sleep(2 ** attempt * 1000); continue; }
      // Final failure: mark failed unless it's rate-limiting (they succeed next cycle).
      if (!DRY_RUN && !String(e.message).includes('429')) {
        try { await companiesRepo.markFailed(company.id, e.message); } catch { /* non-fatal */ }
      }
      logger.warn({ companyId: company.id, ats: company.ats, err: e.message }, 'sync failed (retries exhausted)');
      return { added: 0, removed: 0, failed: true };
    }
  }
  return { added: 0, removed: 0, failed: true };
}

(async () => {
  const t0 = Date.now();
  const due = await companiesRepo.findDueForSync({ shard: SHARD, shardCount: SHARD_COUNT, limit: LIMIT });
  logger.info({ shard: SHARD, shardCount: SHARD_COUNT, due: due.length, concurrency: CONCURRENCY, dryRun: DRY_RUN }, 'sync-once start');

  let i = 0, added = 0, removed = 0, failed = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < due.length) {
      const c = due[i++];
      const d = await syncWithRetry(c);
      added += d.added || 0; removed += d.removed || 0; if (d.failed) failed++;
      if (++done % 100 === 0) logger.info({ done, total: due.length, added, removed, failed }, 'progress');
    }
  }));

  logger.info({ due: due.length, added, removed, failed, minutes: ((Date.now() - t0) / 60000).toFixed(1) }, 'sync-once done');
  await closeDb();
  process.exit(0);
})().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'sync-once fatal'); process.exit(1); });
