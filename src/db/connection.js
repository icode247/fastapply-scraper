const config = require('../config');
const logger = require('../logger');

const isPostgres = !!process.env.DATABASE_URL;

let db; // SQLite instance
let pool; // PG pool

function getDb() {
  if (isPostgres) {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: parseInt(process.env.PG_POOL_MAX, 10) || 15,
        // Defaults are generous so a high-latency link (e.g. testing from far away)
        // clears the ~9s TLS handshake; on an in-region Actions runner it connects in
        // <100ms so these never bite. Override via env if needed.
        idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT, 10) || 30000,
        connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT, 10) || 30000,
        // Abort any query that runs longer than 60s instead of hanging forever on a
        // half-dead connection (the SA->us-east-1 link drops mid-query and, without
        // these, a query never returns — freezing the whole crawl loop).
        statement_timeout: 60000,
        query_timeout: 60000,
      });
      // Idle clients can be terminated by the server (Heroku) or a flaky link; pg
      // emits 'error' on the pool for those. Without a listener Node treats it as an
      // uncaught exception and crashes the process — so swallow/log it; the next
      // query just acquires a fresh client.
      pool.on('error', (err) => logger.warn({ err: err.message }, 'PG pool idle-client error (ignored)'));
      logger.info('PostgreSQL pool connected');
    }
    return pool;
  }

  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(config.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: config.DATABASE_PATH }, 'SQLite database connected');
  }
  return db;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

/**
 * Unified query helper. Works with both SQLite and PostgreSQL.
 * - sql: SQL string with ? placeholders (auto-converted to $1,$2... for PG)
 * - params: array of parameters
 * Returns: { rows, rowCount, lastId }
 */
async function query(sql, params = []) {
  if (isPostgres) {
    // Convert ? placeholders to $1, $2, etc.
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    // Convert datetime('now') to NOW()
    const finalSql = pgSql
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

    const result = await getDb().query(finalSql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      lastId: result.rows?.[0]?.id || null,
    };
  }

  // SQLite — convert ILIKE to LIKE (SQLite LIKE is case-insensitive for ASCII)
  const sqliteSql = sql.replace(/ILIKE/gi, 'LIKE');
  const database = getDb();
  const isSelect = sqliteSql.trimStart().toUpperCase().startsWith('SELECT');
  const isInsert = sqliteSql.trimStart().toUpperCase().startsWith('INSERT');

  if (isSelect) {
    const rows = database.prepare(sqliteSql).all(...params);
    return { rows, rowCount: rows.length, lastId: null };
  }

  const result = database.prepare(sqliteSql).run(...params);
  return {
    rows: [],
    rowCount: result.changes,
    lastId: isInsert ? result.lastInsertRowid : null,
  };
}

/**
 * Run multiple statements (for schema creation). Only for DDL.
 */
async function exec(sql) {
  if (isPostgres) {
    const pgSql = sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT');
    await getDb().query(pgSql);
  } else {
    getDb().exec(sql);
  }
}

/**
 * Run a function inside a transaction.
 */
async function transaction(fn) {
  if (isPostgres) {
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        async query(sql, params = []) {
          let idx = 0;
          const pgSql = sql
            .replace(/\?/g, () => `$${++idx}`)
            .replace(/datetime\('now'\)/gi, 'NOW()')
            .replace(/INSERT OR IGNORE/gi, 'INSERT');
          return client.query(pgSql, params);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // SQLite transactions are synchronous
  const database = getDb();
  return database.transaction(() => fn({
    query(sql, params = []) {
      const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        return { rows: database.prepare(sql).all(...params) };
      }
      const result = database.prepare(sql).run(...params);
      return { rows: [], rowCount: result.changes };
    },
  }))();
}

module.exports = { getDb, closeDb, query, exec, transaction, isPostgres };
