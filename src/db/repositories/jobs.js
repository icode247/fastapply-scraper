const { query, transaction, isPostgres } = require('../connection');
const logger = require('../../logger');

/**
 * Build WHERE clauses from filters.
 * Returns { clauses: string[], params: any[], needsJoin: boolean }
 */
function buildFilters(filters = {}) {
  const clauses = ['j.removed_at IS NULL'];
  const params = [];
  let needsJoin = false;

  // Role / Keywords — use full-text search on Postgres, ILIKE fallback on SQLite
  if (filters.q) {
    // Support comma-separated role queries: "Senior Developer, technical writer"
    // Each comma-separated term is a separate role query, OR'd together
    const roles = filters.q.split(',').map(r => r.trim()).filter(Boolean);

    if (isPostgres) {
      if (roles.length === 1) {
        // Single role: AND all words together
        const tsquery = roles[0].split(/\s+/).filter(Boolean).join(' & ');
        clauses.push("j.search_vector @@ to_tsquery('english', ?)");
        params.push(tsquery);
      } else {
        // Multiple roles: each role is AND'd internally, roles are OR'd together
        const tsqueries = roles.map(role => {
          const words = role.split(/\s+/).filter(Boolean).join(' & ');
          params.push(words);
          return "j.search_vector @@ to_tsquery('english', ?)";
        });
        clauses.push('(' + tsqueries.join(' OR ') + ')');
      }
    } else {
      if (roles.length === 1) {
        const terms = roles[0].split(/\s+/).filter(Boolean);
        for (const term of terms) {
          clauses.push('(j.title ILIKE ? OR j.department ILIKE ? OR c.company_name ILIKE ?)');
          const pattern = `%${term}%`;
          params.push(pattern, pattern, pattern);
          needsJoin = true;
        }
      } else {
        const roleClauses = roles.map(role => {
          const terms = role.split(/\s+/).filter(Boolean);
          const termClauses = terms.map(term => {
            const pattern = `%${term}%`;
            params.push(pattern, pattern, pattern);
            return '(j.title ILIKE ? OR j.department ILIKE ? OR c.company_name ILIKE ?)';
          });
          return '(' + termClauses.join(' AND ') + ')';
        });
        clauses.push('(' + roleClauses.join(' OR ') + ')');
        needsJoin = true;
      }
    }
  }

  // Helper: normalize a filter that may be string | array | comma-separated string
  // into a deduped array of trimmed non-empty values, lowercased for
  // case-insensitive callers. Returns [] if nothing usable.
  const toList = (v) => {
    if (v == null) return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      const s = String(item).trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  };

  // Work mode: remote, hybrid, onsite — multi-value (OR semantics)
  // Each mode adds its own OR-block; the whole work_mode group is then OR'd
  // together so e.g. work_mode=remote,hybrid returns ANY remote OR hybrid job.
  {
    const modes = toList(filters.workMode).map((m) => m.toLowerCase()).filter((m) => m !== 'any');
    if (modes.length > 0) {
      const groups = [];
      for (const m of modes) {
        if (m === 'remote') {
          groups.push('(j.workplace_type ILIKE ? OR j.location ILIKE ? OR j.title ILIKE ?)');
          params.push('%remote%', '%remote%', '%remote%');
        } else if (m === 'hybrid') {
          groups.push('(j.workplace_type ILIKE ? OR j.location ILIKE ?)');
          params.push('%hybrid%', '%hybrid%');
        } else if (m === 'onsite' || m === 'on-site' || m === 'on_site') {
          groups.push('(j.workplace_type ILIKE ? OR j.workplace_type ILIKE ?)');
          params.push('%on-site%', '%onsite%');
        }
      }
      if (groups.length > 0) clauses.push('(' + groups.join(' OR ') + ')');
    }
  }

  // Employment type: full-time, part-time, contract, internship — multi-value
  {
    const types = toList(filters.employmentType).filter((t) => t.toLowerCase() !== 'any');
    if (types.length > 0) {
      const groups = types.map(() => '(j.employment_type ILIKE ? OR j.title ILIKE ?)');
      clauses.push('(' + groups.join(' OR ') + ')');
      for (const t of types) params.push(`%${t}%`, `%${t}%`);
    }
  }

  // Location — multi-value free-text match (OR'd)
  {
    const locs = toList(filters.location);
    if (locs.length > 0) {
      const groups = locs.map(() => 'j.location ILIKE ?');
      clauses.push('(' + groups.join(' OR ') + ')');
      for (const l of locs) params.push(`%${l}%`);
    }
  }

  // Posted — time window: 24h, 7d, 30d, 90d
  if (filters.posted) {
    const intervals = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
    const days = intervals[filters.posted];
    if (days) {
      if (isPostgres) {
        clauses.push(`COALESCE(j.posted_at, j.first_seen_at) >= NOW() - INTERVAL '${days} days'`);
      } else {
        clauses.push(`COALESCE(j.posted_at, j.first_seen_at) >= datetime('now', '-${days} days')`);
      }
    }
  }

  // Remote filter (uses indexed boolean column)
  if (filters.remote === 'true') {
    clauses.push('j.is_remote = true');
  }

  // Remote worldwide filter
  if (filters.remoteWorldwide === 'true') {
    clauses.push('j.remote_worldwide = true');
  }

  // Visa sponsorship filter
  if (filters.visa) {
    clauses.push('j.visa_sponsorship = ?');
    params.push(filters.visa);
  }

  // Experience level filter — multi-value (SQL IN)
  {
    const levels = toList(filters.experienceLevel);
    if (levels.length > 0) {
      clauses.push(`j.experience_level IN (${levels.map(() => '?').join(', ')})`);
      params.push(...levels);
    }
  }

  // Exact filters
  if (filters.companyId) {
    clauses.push('j.company_id = ?');
    params.push(filters.companyId);
  }
  {
    // ATS filter now uses toList so callers may pass either an array OR a
    // comma-separated string (the route handler historically split on commas,
    // but with toList we accept both forms transparently).
    const atsList = toList(filters.ats);
    if (atsList.length > 0) {
      clauses.push(`j.ats IN (${atsList.map(() => '?').join(', ')})`);
      params.push(...atsList);
    }
  }

  return { clauses, params, needsJoin };
}

const jobsRepo = {
  async findActive(filters = {}) {
    const { clauses, params, needsJoin } = buildFilters(filters);

    // Always join companies for company data in response
    // Optionally include description (excluded by default for performance)
    const descCol = filters.includeDescription ? ', j.description' : '';
    let sql = `SELECT j.id, j.external_id, j.company_id, j.ats, j.title, j.department,
        j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max,
        j.salary_currency, j.salary_interval, j.url, j.posted_at, j.first_seen_at,
        j.is_remote, j.remote_worldwide, j.visa_sponsorship, j.experience_level,
        c.domain, c.ats_slug, c.company_name, c.logo_url${descCol}
      FROM jobs j JOIN companies c ON j.company_id = c.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY j.first_seen_at DESC, j.random_rank`;

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const { rows } = await query(sql, params);
    return rows;
  },

  async countActive(filters = {}) {
    const { clauses, params, needsJoin } = buildFilters(filters);

    // For unfiltered counts on Postgres, use fast estimated count
    const isUnfiltered = clauses.length === 1 && clauses[0] === 'j.removed_at IS NULL';
    if (isUnfiltered && isPostgres) {
      const { rows } = await query(
        "SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'jobs'"
      );
      const estimate = parseInt(rows[0]?.count, 10);
      // Use estimate if reasonable (> 0), otherwise fall back to exact
      if (estimate > 0) return estimate;
    }

    let sql;
    if (needsJoin) {
      sql = `SELECT COUNT(*) as count FROM jobs j JOIN companies c ON j.company_id = c.id WHERE ${clauses.join(' AND ')}`;
    } else {
      sql = `SELECT COUNT(*) as count FROM jobs j WHERE ${clauses.join(' AND ')}`;
    }

    const { rows } = await query(sql, params);
    return parseInt(rows[0].count, 10);
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT j.*, c.domain, c.ats_slug, c.company_name, c.logo_url FROM jobs j
       JOIN companies c ON j.company_id = c.id WHERE j.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async syncForCompany(companyId, ats, incomingJobs) {
    let added = 0;
    let updated = 0;
    let removed = 0;
    let skippedRemoval = false;

    // Only sync jobs posted within the last 30 days — users want fresh listings.
    // Jobs without a posted date are kept (can't determine age).
    const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const freshJobs = incomingJobs.filter(job => {
      if (!job.posted_at) return true;
      const posted = new Date(job.posted_at);
      return !isNaN(posted.getTime()) && posted >= THIRTY_DAYS_AGO;
    });

    await transaction(async (tx) => {
      const { rows: existingJobs } = await tx.query(
        'SELECT id, external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL',
        [companyId]
      );

      const existingMap = new Map(existingJobs.map(j => [j.external_id, j.id]));
      const incomingIds = new Set(freshJobs.map(j => j.external_id));

      for (const job of freshJobs) {
        await tx.query(
          `INSERT INTO jobs (
            external_id, company_id, ats, title, department, location,
            workplace_type, employment_type,
            salary_min, salary_max, salary_currency, salary_interval,
            description, url, posted_at, raw_data,
            visa_sponsorship, experience_level, is_remote, remote_worldwide,
            first_seen_at, last_seen_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(external_id, company_id) DO UPDATE SET
            title = EXCLUDED.title,
            department = EXCLUDED.department,
            location = EXCLUDED.location,
            workplace_type = EXCLUDED.workplace_type,
            employment_type = EXCLUDED.employment_type,
            salary_min = EXCLUDED.salary_min,
            salary_max = EXCLUDED.salary_max,
            salary_currency = EXCLUDED.salary_currency,
            salary_interval = EXCLUDED.salary_interval,
            description = COALESCE(EXCLUDED.description, jobs.description),
            url = EXCLUDED.url,
            posted_at = EXCLUDED.posted_at,
            raw_data = EXCLUDED.raw_data,
            visa_sponsorship = CASE WHEN EXCLUDED.visa_sponsorship != '' THEN EXCLUDED.visa_sponsorship ELSE jobs.visa_sponsorship END,
            experience_level = CASE WHEN EXCLUDED.experience_level != '' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
            is_remote = EXCLUDED.is_remote,
            remote_worldwide = EXCLUDED.remote_worldwide,
            last_seen_at = datetime('now'),
            removed_at = NULL`,
          [
            job.external_id, companyId, ats,
            job.title, job.department || null, job.location,
            job.workplace_type || null, job.employment_type || null,
            job.salary_min || null, job.salary_max || null,
            job.salary_currency || null, job.salary_interval || null,
            job.description || null, job.url, job.posted_at || null,
            JSON.stringify(job.raw_data || null),
            job.visa_sponsorship || '',
            job.experience_level || '',
            job.is_remote || false,
            job.remote_worldwide || false,
          ]
        );
        if (existingMap.has(job.external_id)) {
          updated++;
        } else {
          added++;
        }
      }

      // Guard against partial API responses wiping out jobs
      const existingCount = existingMap.size;
      const missingCount = [...existingMap.keys()].filter(id => !incomingIds.has(id)).length;
      const skipRemoval = existingCount > 0 && (
        freshJobs.length === 0 ||
        missingCount / existingCount > 0.5
      );

      if (skipRemoval) {
        skippedRemoval = true;
        logger.warn(
          { companyId, ats, existingCount, incomingCount: freshJobs.length, missingCount },
          'Skipping job removal — incoming count dropped too much, likely partial API response'
        );
      } else {
        for (const [externalId, dbId] of existingMap) {
          if (!incomingIds.has(externalId)) {
            await tx.query("UPDATE jobs SET removed_at = datetime('now') WHERE id = ?", [dbId]);
            removed++;
          }
        }
      }
    });

    logger.info({ companyId, added, updated, removed, skippedRemoval }, 'Job sync diff complete');
    return { added, updated, removed };
  },
};

module.exports = jobsRepo;
