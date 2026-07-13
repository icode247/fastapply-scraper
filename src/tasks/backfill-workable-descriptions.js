/**
 * Backfill missing Workable job descriptions.
 * Fetches from v2 API one at a time with delays.
 * Runs independently from the sync queue to avoid blocking.
 */
const { query } = require('../db/connection');
const logger = require('../logger');

// Defaults match the original (safe for the Heroku worker). A proxied standalone
// run (see runner at the bottom) overrides these via env — no anti-rate-limit
// delay needed since each request egresses from a fresh residential IP.
const DELAY_MS = parseInt(process.env.WK_DESC_DELAY_MS || '3000', 10);
const FAIL_DELAY_MS = parseInt(process.env.WK_DESC_FAIL_DELAY_MS || '1000', 10);
const BATCH_SIZE = parseInt(process.env.WK_DESC_BATCH || '100', 10);
const MAX_CONSEC_FAIL = parseInt(process.env.WK_DESC_MAX_FAIL || '5', 10);
const CONCURRENCY = parseInt(process.env.WK_DESC_CONCURRENCY || '1', 10);

async function backfillDescriptions() {
  logger.info('Workable backfill: querying for jobs without descriptions');

  const { rows: jobs } = await query(
    `SELECT j.id, j.external_id, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'workable' AND j.removed_at IS NULL
       AND (j.description IS NULL OR j.description = '')
     ORDER BY j.first_seen_at DESC
     LIMIT ?`,
    [BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('Workable backfill: no jobs need descriptions');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Workable backfill: starting batch');

  let filled = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let bail = false;

  // Process one job: fetch its v2 detail and update the description. Returns
  // 'filled' | 'skipped' | 'failed'.
  async function processJob(job) {
    const shortcode = job.external_id.replace('workable_', '');
    const slug = job.ats_slug;
    const url = `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${shortcode}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const detail = await res.json();
        const parts = [detail.description, detail.requirements, detail.benefits].filter(Boolean);
        const description = parts.join('\n') || null;
        if (description) {
          await query('UPDATE jobs SET description = ? WHERE id = ?', [description, job.id]);
          return 'filled';
        }
        logger.debug({ jobId: job.id, slug, shortcode }, 'Workable backfill: API returned no description content');
        return 'skipped';
      }
      logger.warn({ jobId: job.id, slug, shortcode, status: res.status }, 'Workable backfill: non-OK response');
      return 'failed';
    } catch (err) {
      logger.warn({ jobId: job.id, slug, shortcode, err: err.message }, 'Workable backfill: fetch error');
      return 'failed';
    }
  }

  const tally = (r) => { if (r === 'filled') filled++; else if (r === 'skipped') skipped++; else failed++; };

  if (CONCURRENCY <= 1) {
    // Sequential path — unchanged behaviour (used by the Heroku worker).
    for (const job of jobs) {
      if (consecutiveFailures >= MAX_CONSEC_FAIL) {
        logger.warn({ consecutiveFailures, processed: filled + failed + skipped }, 'Workable backfill: too many consecutive failures, stopping batch early');
        break;
      }
      const r = await processJob(job);
      tally(r);
      consecutiveFailures = r === 'failed' ? consecutiveFailures + 1 : 0;
      await new Promise((res) => setTimeout(res, r === 'failed' ? FAIL_DELAY_MS : DELAY_MS));
    }
  } else {
    // Concurrent pool (proxied runs): each request gets its own residential IP,
    // so the consecutive-failure bail isn't needed — but keep a global kill switch
    // if nearly everything fails (bad creds / proxy down) to avoid burning bandwidth.
    let i = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (i < jobs.length && !bail) {
        const job = jobs[i++];
        tally(await processJob(job));
        done++;
        if (done >= 40 && failed / done > 0.9) { bail = true; logger.warn({ failed, done }, 'Workable backfill: >90% failing, stopping (proxy/creds issue?)'); }
        if (DELAY_MS) await new Promise((res) => setTimeout(res, DELAY_MS));
      }
    }));
  }

  logger.info({ filled, failed, skipped, total: jobs.length }, 'Workable backfill: batch complete');
  return filled;
}

module.exports = { backfillDescriptions };

// Standalone proxied runner: loops backfillDescriptions() until the queue is empty.
// Run via scripts/backfill-workable-desc-proxy.sh (installs the IPRoyal proxy so the
// v2 detail endpoint isn't 403/429-blocked). Suggested env:
//   WK_DESC_DELAY_MS=0 WK_DESC_BATCH=200 WK_DESC_MAX_FAIL=9999
if (require.main === module) {
  const proxy = require('../utils/proxy');
  (async () => {
    if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
    const proxied = proxy.install();
    console.log(`Workable description backfill runner${proxied ? ' | PROXIED (rotating residential)' : ' | DIRECT'}`);
    let totalFilled = 0, emptyRounds = 0;
    while (true) {
      let filled = 0;
      try { filled = await backfillDescriptions(); }
      catch (e) { console.error('batch error:', e.message); await new Promise(r => setTimeout(r, 5000)); continue; }
      totalFilled += filled;
      if (filled === 0) {
        // Nothing filled — either done, or the drain hasn't produced new nulls yet.
        if (++emptyRounds >= 3) { console.log(`No jobs need descriptions. Total filled: ${totalFilled}. Exiting.`); break; }
        await new Promise(r => setTimeout(r, 30000));
      } else {
        emptyRounds = 0;
        console.log(`  filled ${filled} this batch | total ${totalFilled}`);
      }
    }
    process.exit(0);
  })().catch((e) => { console.error('FATAL', e); process.exit(1); });
}
