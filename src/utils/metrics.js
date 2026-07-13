const logger = require('../logger');

let redis = null;
const METRICS_PREFIX = 'metrics:';

function setRedis(client) {
  redis = client;
}

async function increment(key, amount = 1) {
  if (!redis) return;
  try {
    await redis.hincrby(`${METRICS_PREFIX}counters`, key, amount);
  } catch { /* ignore */ }
}

async function gauge(key, value) {
  if (!redis) return;
  try {
    await redis.hset(`${METRICS_PREFIX}gauges`, key, String(value));
  } catch { /* ignore */ }
}

async function timing(key, ms) {
  if (!redis) return;
  try {
    await redis.hset(`${METRICS_PREFIX}timing`, key, String(ms));
  } catch { /* ignore */ }
}

async function getAll() {
  if (!redis) return { counters: {}, gauges: {}, timing: {} };
  try {
    const [counters, gauges, timings] = await Promise.all([
      redis.hgetall(`${METRICS_PREFIX}counters`),
      redis.hgetall(`${METRICS_PREFIX}gauges`),
      redis.hgetall(`${METRICS_PREFIX}timing`),
    ]);
    return { counters: counters || {}, gauges: gauges || {}, timing: timings || {} };
  } catch {
    return { counters: {}, gauges: {}, timing: {} };
  }
}

module.exports = { setRedis, increment, gauge, timing, getAll };
