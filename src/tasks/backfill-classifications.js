/**
 * Backfill classification fields (visa_sponsorship, experience_level, is_remote, remote_worldwide)
 * for existing jobs that have descriptions but haven't been classified yet.
 * Uses LLM (HF Inference API) for accurate classification with regex fallback.
 */
const { query } = require('../db/connection');
const { classifyJobWithLLM } = require('../utils/classify-llm');
const logger = require('../logger');

const BATCH_SIZE = 100; // Smaller batches for LLM API rate limits
const CONCURRENCY = 10; // Parallel LLM requests

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function backfillClassifications() {
  // Find jobs with descriptions but no visa_sponsorship classification
  const { rows: jobs } = await query(
    `SELECT id, title, description, location, workplace_type
     FROM jobs
     WHERE removed_at IS NULL
       AND description IS NOT NULL
       AND description != ''
       AND (visa_sponsorship IS NULL OR visa_sponsorship = '' OR visa_sponsorship = 'unknown')
     ORDER BY first_seen_at DESC
     LIMIT ?`,
    [BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('Classification backfill: all jobs classified');
    return 0;
  }

  logger.info({ count: jobs.length }, 'Classification backfill: starting batch');

  let classified = 0;
  let llmSuccess = 0;
  let regexFallback = 0;

  const results = await runWithConcurrency(jobs, CONCURRENCY, async (job) => {
    try {
      const classification = await classifyJobWithLLM(job);

      await query(
        `UPDATE jobs SET
          visa_sponsorship = COALESCE(?, visa_sponsorship, 'unknown'),
          experience_level = COALESCE(?, experience_level),
          is_remote = COALESCE(?, is_remote),
          remote_worldwide = COALESCE(?, remote_worldwide)
        WHERE id = ?`,
        [
          classification.visa_sponsorship,
          classification.experience_level,
          classification.is_remote,
          classification.remote_worldwide,
          job.id,
        ]
      );
      return 'ok';
    } catch (err) {
      logger.warn({ jobId: job.id, err: err.message }, 'Classification failed');
      return 'error';
    }
  });

  classified = results.filter(r => r === 'ok').length;

  logger.info({ classified, total: jobs.length }, 'Classification backfill: batch complete');
  return classified;
}

module.exports = { backfillClassifications };
