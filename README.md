# fastapply-scraper

Stateless job-scrape compute for **fastapply**, designed to run on **free GitHub Actions**
and write directly to the shared Heroku Postgres. It replaces the always-on Heroku `worker`
dyno + Redis/BullMQ (~$65/mo) with scheduled cron runs — **no queue, no Redis, no server**.

All authoritative state is `companies.last_synced_at` in Postgres, so each run just
recomputes the due-set and crawls it. This repo is **public** only so Actions minutes are
free; the product code and the DB itself stay private (the DB URL is an encrypted secret,
scoped to a least-privilege role).

## What runs

| Workflow | Cadence | Does |
|---|---|---|
| `sync.yml` | hourly | 16 parallel shards (`id % 16`), each drains its slice of the due companies via the ATS adapters → UPSERT jobs (`sync-once.js`) |
| `maintenance.yml` | 15 min / hourly / daily | description + classification backfills, dead-job pruning, 90-day cleanup, and a daily anomaly check that opens a GitHub Issue if a platform's job count craters (`maintenance-once.js`, `anomaly-check.js`) |

**Not here (stays on the local Mac crawler behind the residential proxy):** `workable`
sync + the workable marketplace crawl — Workable hard-blocks datacenter IPs, which is all
GitHub runners have. `pinpoint`/`comeet` likewise stay local. The Heroku **web API + Postgres**
also stay on Heroku — this repo is compute only.

## One-time setup

1. **Create the public repo and push:**
   ```bash
   gh repo create <you>/fastapply-scraper --public --source=. --remote=origin --push
   ```
2. **Mint a least-privilege DB credential** (so a leaked secret can't drop tables):
   ```bash
   heroku pg:credentials:create fastapply-board:DATABASE --name actions-scraper
   heroku pg:psql -a fastapply-board < sql/setup-actions-role.sql   # stats table + grants
   heroku pg:credentials:url  fastapply-board --name actions-scraper # copy the URL
   ```
3. **Add the secret:** repo → Settings → Secrets and variables → Actions → new secret
   `DATABASE_URL` = the scoped credential URL from step 2.
4. **Shadow-run:** the workflows fire on their cron automatically (or run `sync.yml` via
   *Run workflow*). Leave the Heroku worker running — `id % 16` sharding + idempotent
   UPSERTs mean the two never conflict. Watch insert rates for 48–72h, then:
   ```bash
   heroku ps:scale worker=0 -a fastapply-board      # cut the worker
   # ...observe 48h, then remove Redis:
   heroku addons:destroy heroku-redis:<plan> -a fastapply-board
   ```
   **Rollback** (as long as Redis still exists): `heroku ps:scale worker=1 -a fastapply-board`.

## Local dev

```bash
npm ci
DATABASE_URL=… NODE_ENV=production DRY_RUN=1 LIMIT=15 node sync-once.js   # no-write dry run
DATABASE_URL=… NODE_ENV=production node maintenance-once.js --task deadjobs
```
Env: `SHARD`/`SHARD_COUNT`/`LIMIT`/`CONCURRENCY`, `DRY_RUN=1`, `PG_CONNECT_TIMEOUT` (raise
when testing from a high-latency link — in-region Actions runners connect in <100 ms).

## Provenance

Carved from `job-aggregator/src` (adapters, utils, db, tasks — verbatim). `sync-once.js`
ports the BullMQ worker body from `src/queues/sync.queue.js`; `maintenance-once.js` ports the
`setTimeout` loops from `src/worker.js`. Anomaly detection follows the approach in the
reference `job-board-aggregator` scraper's `check_anomalies.py`.
