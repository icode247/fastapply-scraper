const { query } = require('../connection');

const companiesRepo = {
  async findAll() {
    const { rows } = await query('SELECT * FROM companies ORDER BY id');
    return rows;
  },

  async findPending() {
    const { rows } = await query("SELECT * FROM companies WHERE status = 'pending' AND ats IS NULL");
    return rows;
  },

  async findActive() {
    const { rows } = await query("SELECT * FROM companies WHERE status = 'active'");
    return rows;
  },

  async findDueForSync({ shard = 0, shardCount = 1, limit = 1500 } = {}) {
    // Round-robin by staleness: never-synced first, then oldest-synced.
    // Restricted to the ATS platforms where global remote roles concentrate
    // OR where we've manually seeded companies from external datasets:
    //   ashby, greenhouse, breezy, smartrecruiters — primary global remote feeds
    //   bamboohr                                    — seeded via Apify dataset imports
    //   lever, workday                              — re-enabled; both have healthy
    //                                                 APIs + large job inventories.
    //                                                 (workday/lever throttled via
    //                                                 ATS_MAX_CONCURRENT in sync.queue)
    //   icims                                        — enabled 2026-06-30: adapter works
    //                                                 (classic-portal scrape) but had never
    //                                                 been scheduled (oversight, not a pause),
    //                                                 leaving ~1k companies permanently empty.
    //                                                 Throttled via ATS_MAX_CONCURRENT.
    //   oracle                                       — re-enabled 2026-06-30: adapter is NOT
    //                                                 broken (verified: hcal.us2.CX_1001 -> 56
    //                                                 jobs, fa-ewgu...CX_2001 -> 538). The 0-jobs
    //                                                 state was just staleness — oracle hadn't
    //                                                 synced since 03-23, so its rows aged out of
    //                                                 the 90d window. 326/427 slugs are well-formed.
    // Other platforms (workable, recruitee, pinpoint, jazzhr, personio, rippling,
    // zoho, comeet, paylocity) remain PAUSED — their existing rows stay in the DB
    // but no new sync cycles run. (workable 403-blocks direct API access.)
    // NOTE: 'oraclecloud' (357 cos) is the SAME platform under a different label, but
    // its slugs are bare tenants (no region/siteNumber) that need reconstruction +
    // siteNumber discovery before they're worth scheduling — handled separately.
    // Stale threshold: 60 min — job boards rarely update faster than hourly.
    //
    // PER-PLATFORM ROUND-ROBIN: rank each platform's due companies by staleness, then
    // interleave (oldest-of-each-platform first, then 2nd-oldest, ...). A pure global
    // "last_synced ASC NULLS FIRST" let one platform's backlog/NULL burst monopolize
    // the 1500-row fanout and starve the others (e.g. re-enabling workday added ~1.7k
    // NULLs that blocked greenhouse's 11k stale rows). Round-robin guarantees every
    // active platform gets a fair share of each fanout regardless of backlog size.
    const { rows } = await query(`
      SELECT id, ats, ats_slug FROM (
        SELECT id, ats, ats_slug, last_synced_at,
          ROW_NUMBER() OVER (PARTITION BY ats ORDER BY last_synced_at ASC NULLS FIRST) AS rn
        FROM companies
        WHERE status = 'active'
          AND ats IS NOT NULL
          AND ats IN ('ashby','greenhouse','breezy','smartrecruiters','bamboohr','lever','workday','icims','oracle','recruitee','zoho','successfactors','paylocity')
          AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '60 minutes')
          AND (id % ?) = ?
      ) ranked
      ORDER BY rn, last_synced_at ASC NULLS FIRST
      LIMIT ?
    `, [shardCount, shard, limit]);
    return rows;
  },

  async findAllPaginated(limit = 100, offset = 0) {
    const { rows } = await query('SELECT * FROM companies ORDER BY id LIMIT ? OFFSET ?', [limit, offset]);
    return rows;
  },

  async countAll() {
    const { rows } = await query('SELECT COUNT(*) as count FROM companies');
    return parseInt(rows[0].count, 10);
  },

  async countActive() {
    const { rows } = await query("SELECT COUNT(*) as count FROM companies WHERE status = 'active'");
    return parseInt(rows[0].count, 10);
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM companies WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async findByUrl(careerUrl) {
    const { rows } = await query('SELECT * FROM companies WHERE career_url = ?', [careerUrl]);
    return rows[0] || null;
  },

  async create({ careerUrl, domain }) {
    const { rowCount, lastId } = await query(
      'INSERT INTO companies (career_url, domain) VALUES (?, ?) ON CONFLICT(career_url) DO NOTHING',
      [careerUrl, domain]
    );
    if (rowCount === 0) return this.findByUrl(careerUrl);
    return this.findById(lastId);
  },

  async updateDiscovery(id, { ats, atsSlug }) {
    await query(
      `UPDATE companies SET ats = ?, ats_slug = ?, status = 'active',
       last_discovered_at = datetime('now'), updated_at = datetime('now'), error_message = NULL
       WHERE id = ?`,
      [ats, atsSlug, id]
    );
  },

  async updateMeta(id, { companyName, logoUrl }) {
    const sets = [];
    const params = [];
    if (companyName) { sets.push('company_name = ?'); params.push(companyName); }
    if (logoUrl) { sets.push('logo_url = ?'); params.push(logoUrl); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    await query(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`, params);
  },

  async markUnsupported(id) {
    await query(
      "UPDATE companies SET status = 'unsupported', last_discovered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  async markFailed(id, errorMessage) {
    await query(
      "UPDATE companies SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
      [errorMessage, id]
    );
  },

  async updateLastSynced(id) {
    await query(
      "UPDATE companies SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  async findByAtsAndSlug(ats, slug) {
    const { rows } = await query('SELECT * FROM companies WHERE ats = ? AND ats_slug = ?', [ats, slug]);
    return rows[0] || null;
  },

  async createFromCrawl({ ats, atsSlug, origin }) {
    const boardUrls = {
      greenhouse: `https://boards.greenhouse.io/${atsSlug}`,
      lever: `https://jobs.lever.co/${atsSlug}`,
      ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
      workable: `https://apply.workable.com/${atsSlug}`,
      recruitee: `https://${atsSlug}.recruitee.com`,
      smartrecruiters: `https://careers.smartrecruiters.com/${atsSlug}`,
      rippling: `https://ats.rippling.com/${atsSlug}`,
      personio: `https://${atsSlug}.jobs.personio.de`,
      breezy: `https://${atsSlug}.breezy.hr`,
      jazzhr: `https://app.jazz.co/widgets/basic/create/${atsSlug}`,
      workday: `https://${atsSlug}.myworkdayjobs.com`,
      zoho: `https://${atsSlug}.zohorecruit.com/jobs/Careers`,
      icims: `https://careers.${atsSlug}.com`,
      oracle: `https://${atsSlug}.oraclecloud.com`,
      bamboohr: `https://${atsSlug}.bamboohr.com/careers`,
      taleo: `https://${atsSlug}.taleo.net`,
      pinpoint: `https://${atsSlug}.pinpointhq.com`,
      successfactors: `https://${atsSlug}`, // atsSlug is the CSB career host, e.g. jobs.acme.com
    };
    const careerUrl = boardUrls[ats] || `https://${atsSlug}.com/careers`;
    let domain;
    try {
      const parsed = new URL(careerUrl);
      domain = parsed.hostname;
    } catch {
      domain = `${atsSlug}.com`;
    }

    const { rowCount, lastId } = await query(
      `INSERT INTO companies (career_url, domain, ats, ats_slug, status, origin, last_discovered_at)
       VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))
       ON CONFLICT(career_url) DO NOTHING`,
      [careerUrl, domain, ats, atsSlug, origin || 'crawl']
    );
    if (rowCount === 0) return this.findByUrl(careerUrl);
    return this.findById(lastId);
  },
};

module.exports = companiesRepo;
