-- Run ONCE against the production DB (e.g. `heroku pg:psql -a fastapply-board`).
-- Creates (1) the anomaly-history table and (2) a LEAST-PRIVILEGE role for GitHub Actions.
--
-- Why: DATABASE_URL for the scraper lives in a PUBLIC repo's Actions secrets. Even though
-- secrets aren't exposed to forked-PR runs, we defend in depth — this role can read/write
-- job + company rows but CANNOT create/drop/alter schema, so a leaked credential can't
-- nuke the database.
--
-- HEROKU NOTE: prefer minting the role via the platform, then run only the GRANTs below:
--   heroku pg:credentials:create fastapply-board:DATABASE --name actions-scraper
--   heroku pg:psql -a fastapply-board < sql/setup-actions-role.sql   # table + grants
--   heroku pg:credentials:url fastapply-board --name actions-scraper # -> the DATABASE_URL secret
-- (Heroku creates the role; the CREATE ROLE block below is a no-op if it already exists.)

-- 1) Anomaly-detector history (read/written by anomaly-check.js).
CREATE TABLE IF NOT EXISTS scrape_daily_stats (
  day        date PRIMARY KEY,
  stats      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2) Least-privilege role (skipped if Heroku already created "actions_scraper").
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'actions_scraper') THEN
    -- CHANGE THIS PASSWORD (or use the Heroku-minted credential and delete this line).
    CREATE ROLE actions_scraper LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
  END IF;
END $$;

-- 3) Grant ONLY what the scraper needs. No DDL, no superuser, no other tables.
GRANT USAGE ON SCHEMA public TO actions_scraper;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs, companies TO actions_scraper;
GRANT SELECT, INSERT, UPDATE ON scrape_daily_stats TO actions_scraper;
-- SERIAL primary keys (jobs.id, companies.id) need sequence access for INSERT.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO actions_scraper;

-- Sanity check — should list exactly the grants above.
-- \dp jobs companies scrape_daily_stats
