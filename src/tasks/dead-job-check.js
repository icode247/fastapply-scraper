/**
 * Dead-job detection + pruning.
 *
 * Fetches a job's career-page URL and decides whether the posting is still live.
 * Used by:
 *   - the worker's runDeadJobPruning loop (src/worker.js), and
 *   - the scripts/check-dead-jobs.js CLI.
 *
 * Only *confirmed* dead postings (404/410 or an explicit dead-page phrase) are
 * pruned. Anything uncertain (timeout, 5xx, transient network error) is left
 * alone and simply re-checked on a later rotation.
 */

const DEAD_INDICATORS = [
  'this job posting is no longer available',
  'this position has been filled',
  'this job is no longer available',
  'this posting has expired',
  'job not found',
  'page not found',
  'position is no longer available',
  'this requisition is no longer available',
  'opportunity is no longer available',
  'this job has been closed',
  'job has expired',
  'no longer accepting applications',
  'this role has been filled',
  'listing has been removed',
  'sorry, this job is no longer open',
  'this position is closed',
  'the job you are looking for is no longer available',
  'this job listing has expired',
];

// Returns { alive: true|false|null, reason }. null = uncertain (do NOT prune).
async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobChecker/1.0)' },
    });
    clearTimeout(timeout);

    if (res.status === 404 || res.status === 410) return { alive: false, reason: `HTTP ${res.status}` };
    if (!res.ok) return { alive: null, reason: `HTTP ${res.status}` };

    const html = (await res.text()).toLowerCase();
    for (const indicator of DEAD_INDICATORS) {
      if (html.includes(indicator)) return { alive: false, reason: indicator };
    }
    if (html.length < 500 && (html.includes('sorry') || html.includes('error') || html.includes('not found'))) {
      return { alive: false, reason: `Short error page (${html.length} chars)` };
    }
    return { alive: true, reason: null };
  } catch (err) {
    if (err.name === 'AbortError') return { alive: null, reason: 'Timeout (15s)' };
    return { alive: null, reason: err.message };
  }
}

async function runWithConcurrency(items, maxConcurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Verify a rotating batch of the older job tail and prune confirmed-dead postings.
 *
 * Scope: jobs posted more than `tailDays` ago (recent jobs are kept fresh by the
 * crawler, so we don't waste fetches on them) that haven't been checked within
 * `recheckDays`. Oldest-checked first, so the whole tail rotates over time.
 *
 * @returns {Promise<{checked:number, dead:number, uncertain:number}>}
 */
async function pruneDeadJobs({ limit = 400, concurrency = 10, tailDays = 30, recheckDays = 14 } = {}) {
  const { query } = require('../db/connection');
  const t = Number(tailDays) || 30;
  const r = Number(recheckDays) || 14;

  const { rows: jobs } = await query(
    `SELECT j.id, j.url
       FROM jobs j
      WHERE j.removed_at IS NULL
        AND j.url IS NOT NULL
        AND j.posted_at IS NOT NULL
        AND j.posted_at < NOW() - INTERVAL '${t} days'
        AND (j.last_checked_at IS NULL OR j.last_checked_at < NOW() - INTERVAL '${r} days')
      ORDER BY j.last_checked_at ASC NULLS FIRST
      LIMIT $1`,
    [limit]
  );
  if (!jobs.length) return { checked: 0, dead: 0, uncertain: 0 };

  const deadIds = [];
  let uncertain = 0;
  await runWithConcurrency(jobs, concurrency, async (job) => {
    const result = await checkUrl(job.url);
    if (result.alive === false) deadIds.push(job.id);
    else if (result.alive === null) uncertain++;
  });

  if (deadIds.length) {
    await query('UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[])', [deadIds]);
  }
  // Stamp every checked job so the rotation advances (including the ones we pruned).
  await query('UPDATE jobs SET last_checked_at = NOW() WHERE id = ANY($1::bigint[])', [jobs.map((j) => j.id)]);

  return { checked: jobs.length, dead: deadIds.length, uncertain };
}

module.exports = { DEAD_INDICATORS, checkUrl, runWithConcurrency, pruneDeadJobs };
