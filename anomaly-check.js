#!/usr/bin/env node
/**
 * Daily anomaly detector — our primary defense against a silently-failed Actions run or
 * a broken adapter (a platform's job count craters and nothing else tells us).
 *
 * Ports the reference project's check_anomalies.py z-score idea, but keeps history in
 * Postgres (table `scrape_daily_stats`, seeded by sql/setup-actions-role.sql) instead of
 * a git-committed daily.jsonl — no commit-back step, and PG is already our store.
 *
 * Each run: snapshot today's active-job count per ATS, compare to the trailing window,
 * and if any platform is a >3 sigma move (or a hard drop-to-zero), emit `anomaly=true` +
 * a report to $GITHUB_OUTPUT so the workflow opens a GitHub Issue.
 *
 * Usage: node anomaly-check.js
 */
const { query, closeDb } = require('./src/db/connection');
const logger = require('./src/logger');
const fs = require('fs');

const WINDOW_DAYS = 14;
const Z_THRESHOLD = 3;
const SPARSE_DROP_PCT = 0.5; // with little history, flag a >50% drop

async function main() {
  // Today's snapshot: active jobs per ATS.
  const { rows: today } = await query(
    "SELECT ats, count(*)::int AS n FROM jobs WHERE removed_at IS NULL AND ats IS NOT NULL GROUP BY ats"
  );
  const todayMap = Object.fromEntries(today.map((r) => [r.ats, r.n]));

  // Persist today's snapshot (idempotent for re-runs).
  await query(
    "INSERT INTO scrape_daily_stats (day, stats) VALUES (CURRENT_DATE, ?::jsonb) ON CONFLICT (day) DO UPDATE SET stats = EXCLUDED.stats",
    [JSON.stringify(todayMap)]
  );

  // Trailing history, excluding today.
  const { rows: hist } = await query(
    "SELECT stats FROM scrape_daily_stats WHERE day < CURRENT_DATE ORDER BY day DESC LIMIT ?",
    [WINDOW_DAYS]
  );

  const anomalies = [];
  for (const [ats, n] of Object.entries(todayMap)) {
    const series = hist.map((h) => Number(h.stats?.[ats] ?? 0)).filter((v) => v > 0);
    if (series.length >= 4) {
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
      const std = Math.sqrt(variance);
      if (std > 0) {
        const z = (n - mean) / std;
        if (Math.abs(z) > Z_THRESHOLD) {
          anomalies.push(`${z < 0 ? 'DROP' : 'SPIKE'} **${ats}**: ${n} today vs mean ${mean.toFixed(0)} (z=${z.toFixed(1)})`);
        }
      } else if (n < mean * (1 - SPARSE_DROP_PCT)) {
        anomalies.push(`DROP **${ats}**: ${n} today vs steady ${mean.toFixed(0)}`);
      }
    } else if (series.length >= 1) {
      const prevN = series[0];
      if (n < prevN * (1 - SPARSE_DROP_PCT)) {
        anomalies.push(`DROP **${ats}**: ${n} today vs ${prevN} recently (sparse history)`);
      }
    }
  }

  // Hard drop: a platform that had jobs in the last snapshot but is 0/absent today.
  const prevSnap = hist[0]?.stats || {};
  for (const [ats, pn] of Object.entries(prevSnap)) {
    if (Number(pn) > 10 && !(todayMap[ats] > 0)) {
      anomalies.push(`GONE **${ats}**: was ${pn}, now 0 — adapter likely broken or run skipped`);
    }
  }

  const report = anomalies.length
    ? `Scrape anomalies detected (${anomalies.length}):\n\n- ${anomalies.join('\n- ')}`
    : '';
  logger.info({ platforms: today.length, anomalies: anomalies.length }, 'anomaly check done');
  if (anomalies.length) logger.warn({ report }, 'ANOMALIES');

  // Hand off to the workflow (GitHub Actions) if present.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `anomaly=${anomalies.length ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `report<<EOF\n${report}\nEOF\n`);
  }
  await closeDb();
  process.exit(0);
}

main().catch((e) => { logger.error({ err: e.message, stack: e.stack }, 'anomaly-check fatal'); process.exit(1); });
