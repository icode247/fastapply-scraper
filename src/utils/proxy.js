/**
 * IPRoyal rotating-residential proxy for outbound fetch.
 *
 * Only active when the IPROYAL_PROXY_* env vars are present (instance E sets them;
 * A/B/C don't, so they stay on the direct connection).
 *
 * Workable blocks a residential IP after only ~1-2 requests, so we rotate PER
 * REQUEST: install() monkeypatches global fetch to attach a fresh ProxyAgent
 * (new IPRoyal session token = new residential IP) to every call. This is
 * concurrency-safe (each fetch gets its own dispatcher — no shared global state),
 * so instance E can run several workers in parallel; one slow IP that rides the
 * request timeout no longer stalls the others.
 *
 * Agents use a short keep-alive so idle sockets close quickly and the (now
 * unreferenced) agent is GC'd — bounds FD growth across tens of thousands of req.
 */
const fs = require('fs');
const path = require('path');

let ProxyAgent;
try { ({ ProxyAgent } = require('undici')); } catch { /* undici absent → disabled */ }

function cred(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => l.startsWith(key + '='));
    if (line) return line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim();
  } catch { /* no .env */ }
  return undefined;
}

const HOST = cred('IPROYAL_PROXY_HOST');
const PORT = cred('IPROYAL_PROXY_PORT');
const USER = cred('IPROYAL_PROXY_USER');
const PASS = cred('IPROYAL_PROXY_PASS');
const LIFETIME = cred('IPROYAL_PROXY_LIFETIME') || '10m';

// PROXY_DISABLED=1 force-disables the proxy for an instance (e.g. pinpoint, which
// fails through the residential proxy but works fine direct).
const enabled = !process.env.PROXY_DISABLED && !!(HOST && PORT && USER && PASS && ProxyAgent);

let counter = 0;
function newAgent() {
  const session = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}${counter++}`;
  const uri = `http://${USER}:${PASS}_session-${session}_lifetime-${LIFETIME}@${HOST}:${PORT}`;
  return new ProxyAgent({ uri, keepAliveTimeout: 2000, keepAliveMaxTimeout: 2000 });
}

/** Wrap global fetch so every request egresses from a fresh residential IP. Idempotent. */
let installed = false;
function install() {
  if (!enabled || installed) return enabled && installed;
  const orig = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    // Caller-supplied dispatcher wins (none in our adapters); else a fresh proxied IP.
    if (opts.dispatcher) return orig(url, opts);
    return orig(url, { ...opts, dispatcher: newAgent() });
  };
  installed = true;
  return true;
}

module.exports = { enabled, install, newAgent };
