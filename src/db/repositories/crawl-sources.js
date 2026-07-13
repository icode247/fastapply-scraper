const { query, isPostgres } = require('../connection');

const crawlSourcesRepo = {
  async insertIfNew(ats, slug, source, crawlRun) {
    if (isPostgres) {
      const { rowCount } = await query(
        'INSERT INTO crawl_sources (ats, slug, source, crawl_run) VALUES (?, ?, ?, ?) ON CONFLICT(ats, slug) DO NOTHING',
        [ats, slug, source, crawlRun]
      );
      return rowCount > 0;
    }
    const { rowCount } = await query(
      'INSERT OR IGNORE INTO crawl_sources (ats, slug, source, crawl_run) VALUES (?, ?, ?, ?)',
      [ats, slug, source, crawlRun]
    );
    return rowCount > 0;
  },

  async exists(ats, slug) {
    const { rows } = await query('SELECT 1 FROM crawl_sources WHERE ats = ? AND slug = ?', [ats, slug]);
    return rows.length > 0;
  },

  async countBySource() {
    const { rows } = await query('SELECT source, ats, COUNT(*) as count FROM crawl_sources GROUP BY source, ats');
    return rows;
  },

  async totalCount() {
    const { rows } = await query('SELECT COUNT(*) as count FROM crawl_sources');
    return parseInt(rows[0].count, 10);
  },
};

module.exports = crawlSourcesRepo;
