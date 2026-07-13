const { exec, query, isPostgres } = require('./connection');
const logger = require('../logger');

async function migrate() {
  const autoId = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const now = isPostgres ? 'NOW()' : "datetime('now')";

  await exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                 ${autoId},
      career_url         TEXT NOT NULL UNIQUE,
      domain             TEXT NOT NULL,
      ats                TEXT,
      ats_slug           TEXT,
      status             TEXT DEFAULT 'pending',
      last_discovered_at TIMESTAMP,
      last_synced_at     TIMESTAMP,
      error_message      TEXT,
      company_name       TEXT,
      logo_url           TEXT,
      origin             TEXT DEFAULT 'seed',
      created_at         TIMESTAMP DEFAULT ${now},
      updated_at         TIMESTAMP DEFAULT ${now}
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              ${autoId},
      external_id     TEXT NOT NULL,
      company_id      INTEGER NOT NULL REFERENCES companies(id),
      ats             TEXT NOT NULL,
      title           TEXT NOT NULL,
      department      TEXT,
      location        TEXT,
      workplace_type  TEXT,
      employment_type TEXT,
      salary_min      TEXT,
      salary_max      TEXT,
      salary_currency TEXT,
      salary_interval TEXT,
      description     TEXT,
      url             TEXT,
      posted_at       TIMESTAMP,
      raw_data        TEXT,
      first_seen_at   TIMESTAMP DEFAULT ${now},
      last_seen_at    TIMESTAMP DEFAULT ${now},
      removed_at      TIMESTAMP,
      created_at      TIMESTAMP DEFAULT ${now},
      UNIQUE(external_id, company_id)
    )
  `);

  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_removed_at ON jobs(removed_at)');
  await exec('CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)');

  await exec(`
    CREATE TABLE IF NOT EXISTS crawl_sources (
      id          ${autoId},
      ats         TEXT NOT NULL,
      slug        TEXT NOT NULL,
      source      TEXT NOT NULL,
      crawl_run   TEXT,
      created_at  TIMESTAMP DEFAULT ${now},
      UNIQUE(ats, slug)
    )
  `);

  await exec('CREATE INDEX IF NOT EXISTS idx_crawl_sources_ats ON crawl_sources(ats)');

  // Fix salary columns from INTEGER to TEXT (avoid type issues with decimals)
  if (isPostgres) {
    try {
      await exec('ALTER TABLE jobs ALTER COLUMN salary_min TYPE TEXT USING salary_min::TEXT');
      await exec('ALTER TABLE jobs ALTER COLUMN salary_max TYPE TEXT USING salary_max::TEXT');
    } catch { /* already text */ }
  }

  // Additional indexes for search/sort performance
  if (isPostgres) {
    try { await exec('CREATE EXTENSION IF NOT EXISTS pg_trgm'); } catch { /* may not have permission */ }
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location)');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC)');
    await exec('CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(company_name)');
  }

  // Job classification columns for persona targeting (H1B, remote, entry-level)
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visa_sponsorship TEXT');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_level TEXT');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_remote BOOLEAN DEFAULT FALSE');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS remote_worldwide BOOLEAN DEFAULT FALSE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_is_remote ON jobs(is_remote) WHERE removed_at IS NULL AND is_remote = TRUE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_remote_worldwide ON jobs(remote_worldwide) WHERE removed_at IS NULL AND remote_worldwide = TRUE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_visa ON jobs(visa_sponsorship) WHERE removed_at IS NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_experience ON jobs(experience_level) WHERE removed_at IS NULL');
  }

  // Random rank for shuffling jobs from same sync batch
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS random_rank DOUBLE PRECISION DEFAULT random()');
  }

  // Dead-job pruning: records when each job's URL was last verified live. The worker
  // rotates through jobs least-recently-checked first; partial index keeps that scan cheap.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_last_checked ON jobs(last_checked_at) WHERE removed_at IS NULL');
  }

  // Full-text search (PostgreSQL only)
  if (isPostgres) {
    await exec(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS search_vector tsvector`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_jobs_search ON jobs USING GIN(search_vector)`);
    await exec(`
      CREATE OR REPLACE FUNCTION jobs_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.department, '') || ' ' || coalesce(NEW.location, ''));
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await exec(`DROP TRIGGER IF EXISTS trig_jobs_search ON jobs`);
    await exec(`CREATE TRIGGER trig_jobs_search BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_search_update()`);
    // Backfill existing rows (run in background, don't block startup)
    exec(`UPDATE jobs SET search_vector = to_tsvector('english', coalesce(title, '') || ' ' || coalesce(department, '') || ' ' || coalesce(location, '')) WHERE search_vector IS NULL`)
      .then(r => { if (r?.rowCount) logger.info({ rows: r.rowCount }, 'Backfilled search_vector'); })
      .catch(() => {});
  }

  // Reset empty-string descriptions back to NULL so backfill retries them
  exec(`UPDATE jobs SET description = NULL WHERE description = '' AND removed_at IS NULL`)
    .then(r => { if (r?.rowCount) logger.info({ rows: r.rowCount }, 'Reset empty descriptions to NULL for backfill retry'); })
    .catch(() => {});

  logger.info({ engine: isPostgres ? 'postgresql' : 'sqlite' }, 'Database schema migrated');
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
