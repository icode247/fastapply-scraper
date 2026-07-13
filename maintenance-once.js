#!/usr/bin/env node
/**
 * One-shot maintenance runner — the de-setTimeout replacement for the worker's
 * periodic housekeeping loops (worker.js:42-100). Each invocation runs exactly ONE
 * task and exits; GitHub Actions cron provides the cadence.
 *
 * Tasks (workable marketplace is intentionally NOT here — it stays on the local Mac
 * crawler behind the residential proxy; datacenter IPs get blocked):
 *   --task desc      description backfill        (worker ran every 5 min)
 *   --task classify  visa/remote/experience tags (every 60s)
 *   --task deadjobs  prune confirmed-dead jobs   (hourly; 404/410 only)
 *   --task stale     delete jobs > 90 days old   (every 6h)
 *
 * Usage: node maintenance-once.js --task deadjobs
 * Env:   DATABASE_URL (required)
 */
const { query, closeDb } = require('./src/db/connection');
const logger = require('./src/logger');
const { backfillDescriptions } = require('./src/tasks/backfill-descriptions');
const { backfillClassifications } = require('./src/tasks/backfill-classifications');
const { pruneDeadJobs } = require('./src/tasks/dead-job-check');

process.on('unhandledRejection', (err) => logger.warn({ err: err?.message }, 'unhandledRejection (ignored)'));

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const TASK = arg('task', process.env.TASK || '');

const TASKS = {
  async desc() {
    const filled = await backfillDescriptions();
    logger.info({ filled }, 'description backfill done');
  },
  async classify() {
    await backfillClassifications();
    logger.info('classification backfill done');
  },
  async deadjobs() {
    // Same knobs as worker.js:91 — only 404/410 or a dead-page phrase prunes; 403/transient re-checked later.
    const r = await pruneDeadJobs({ limit: 400, concurrency: 10, tailDays: 30, recheckDays: 14 });
    logger.info(r, 'dead-job pruning done');
  },
  async stale() {
    // worker.js:74 verbatim.
    const { rows } = await query("DELETE FROM jobs WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days' RETURNING id");
    logger.info({ deleted: rows.length }, 'stale-job cleanup done');
  },
};

(async () => {
  const fn = TASKS[TASK];
  if (!fn) { logger.error({ task: TASK, valid: Object.keys(TASKS) }, 'unknown --task'); process.exit(2); }
  logger.info({ task: TASK }, 'maintenance-once start');
  try {
    await fn();
  } catch (e) {
    logger.error({ task: TASK, err: e.message, stack: e.stack }, 'maintenance task failed');
    await closeDb();
    process.exit(1);
  }
  await closeDb();
  process.exit(0);
})();
