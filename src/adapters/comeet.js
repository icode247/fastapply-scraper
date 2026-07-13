/**
 * Comeet ATS adapter.
 * API docs: https://developers.comeet.com/reference/careers-api-overview
 *
 * ats_slug format: "{COMPANY_UID}:{TOKEN}" (colon-separated)
 * career_url format: "https://www.comeet.co/jobs/{COMPANY_UID}"
 *
 * List endpoint returns positions without descriptions.
 * Description backfill uses the detail endpoint per position.
 */
const logger = require('../logger');

const BASE_URL = 'https://www.comeet.co/careers-api/2.0';

function parseSlug(atsSlug) {
  const parts = atsSlug.split(':');
  if (parts.length < 2) throw new Error(`Comeet: invalid slug format "${atsSlug}" — expected "UID:TOKEN"`);
  return { uid: parts[0], token: parts.slice(1).join(':') };
}

function mapLocation(loc) {
  if (!loc) return null;
  const parts = [loc.city, loc.state, loc.country].filter(Boolean);
  return parts.join(', ') || null;
}

function mapWorkplaceType(wt) {
  if (!wt) return null;
  const lower = wt.toLowerCase();
  if (lower.includes('remote')) return 'remote';
  if (lower.includes('hybrid')) return 'hybrid';
  if (lower.includes('on-site') || lower.includes('onsite') || lower.includes('office')) return 'onsite';
  return wt;
}

function mapEmploymentType(et) {
  if (!et) return null;
  const lower = et.toLowerCase();
  if (lower.includes('full')) return 'Full-time';
  if (lower.includes('part')) return 'Part-time';
  if (lower.includes('contract') || lower.includes('freelance')) return 'Contract';
  if (lower.includes('intern')) return 'Internship';
  return et;
}

async function fetchJobs(atsSlug) {
  const { uid, token } = parseSlug(atsSlug);

  const url = `${BASE_URL}/company/${encodeURIComponent(uid)}/positions?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Comeet HTTP ${res.status}`);
  }

  const positions = await res.json();

  if (!Array.isArray(positions)) {
    logger.warn({ atsSlug }, 'Comeet: unexpected response format');
    return { jobs: [], meta: {} };
  }

  let companyName = null;

  const jobs = positions.map(pos => {
    if (!companyName && pos.company_name) companyName = pos.company_name;

    return {
      external_id: `comeet_${pos.uid}`,
      title: pos.name || 'Untitled',
      department: pos.department || null,
      location: mapLocation(pos.location) || null,
      workplace_type: mapWorkplaceType(pos.workplace_type) || null,
      employment_type: mapEmploymentType(pos.employment_type) || null,
      description: pos.details?.description || null,
      url: pos.url_active_page || `https://www.comeet.co/jobs/${uid}/${pos.uid}`,
      posted_at: pos.time_updated || null,
      raw_data: pos,
    };
  });

  return {
    jobs,
    meta: {
      companyName,
    },
  };
}

module.exports = { fetchJobs };
