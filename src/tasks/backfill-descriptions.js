/**
 * Backfill missing job descriptions across all ATS platforms.
 * Fetches individual job details for jobs with NULL descriptions.
 * Runs independently from the sync queue to avoid blocking.
 * Processes each ATS separately with per-ATS rate limits.
 */
const { query } = require('../db/connection');
const { discoverConfig } = require('../adapters/workday');
const logger = require('../logger');
const metrics = require('../utils/metrics');

// Only ATS platforms that return descriptions without Browserless.
// Priority order: Ashby, Breezy, Greenhouse, Workable first, then rest.
const ATS_CONFIG = {
  ashby:           { batchSize: 75, concurrency: 5 },
  breezy:          { batchSize: 75, concurrency: 5 },
  greenhouse:      { batchSize: 75, concurrency: 5 },
  workable:        { batchSize: 75, concurrency: 4 },
  lever:           { batchSize: 75, concurrency: 5 },
  recruitee:       { batchSize: 75, concurrency: 4 },
  pinpoint:        { batchSize: 75, concurrency: 5 },
  smartrecruiters: { batchSize: 75, concurrency: 5 },
  bamboohr:        { batchSize: 75, concurrency: 5 },
  jazzhr:          { batchSize: 75, concurrency: 5 },
  personio:        { batchSize: 50, concurrency: 3 },
  rippling:        { batchSize: 75, concurrency: 5 },
  zoho:            { batchSize: 50, concurrency: 3 },
  workday:         { batchSize: 75, concurrency: 4 },
  comeet:          { batchSize: 50, concurrency: 4 },
};

// Cache workday configs per slug with TTL (1 hour)
const wdConfigCache = new Map();
const WD_CACHE_TTL_MS = 60 * 60 * 1000;

function getWdConfig(key) {
  const entry = wdConfigCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > WD_CACHE_TTL_MS) {
    wdConfigCache.delete(key);
    return undefined;
  }
  return entry.config;
}

function setWdConfig(key, config) {
  wdConfigCache.set(key, { config, timestamp: Date.now() });
}

/**
 * Workday has multiple site slugs per company (e.g. VCA has Careers, BFCareers, etc.)
 * Try all known site slugs if the first one fails with 422.
 */
async function discoverAllSiteSlugs(slug) {
  for (const wd of [1, 2, 3, 5, 12]) {
    try {
      const res = await fetch(`https://${slug}.wd${wd}.myworkdayjobs.com/robots.txt`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = await res.text();
      const matches = [...text.matchAll(/myworkdayjobs\.com\/([^/\s]+)/g)];
      if (matches.length > 0) {
        return { wdNum: wd, siteSlugs: matches.map(m => m[1]) };
      }
    } catch { /* try next */ }
  }
  return null;
}

// Realistic browser headers — some Workday tenants block bare scripted requests.
// (Tenants with stricter permission blocks still return 403 even with these, which
// we then mark SKIP rather than retrying forever.)
const WD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchWorkdayDescription(job, rawData) {
  const cacheKey = job.ats_slug;
  let config = getWdConfig(cacheKey);
  if (config === undefined) {
    config = await discoverAllSiteSlugs(job.ats_slug);
    setWdConfig(cacheKey, config);
  }
  if (!config) return null;

  const { wdNum, siteSlugs } = config;
  const externalPath = rawData?.externalPath;
  if (!externalPath) return null;

  // Try each site slug until one works. Track whether we got a confirmed
  // non-retryable response (403 permission, or 200-with-empty-description)
  // so we can return SKIP instead of null and stop retrying forever.
  let sawForbidden = false;
  let sawEmptyDescription = false;

  for (const siteSlug of siteSlugs) {
    try {
      const url = `https://${job.ats_slug}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${job.ats_slug}/${siteSlug}${externalPath}`;
      const res = await fetch(url, { headers: WD_HEADERS, signal: AbortSignal.timeout(10000) });
      if (res.status === 403) { sawForbidden = true; continue; }
      if (!res.ok) continue; // 422 = wrong siteSlug, try next
      const detail = await res.json();
      const desc = detail?.jobPostingInfo?.jobDescription;
      if (desc && desc.trim()) return desc;
      // 200 OK with a populated jobPostingInfo but no description body → upstream-empty
      if (detail?.jobPostingInfo) sawEmptyDescription = true;
    } catch { /* timeout — try next */ }
  }
  // Tenant-level permission block OR truly empty posting: not retryable.
  if (sawForbidden || sawEmptyDescription) return 'SKIP';
  return null;
}

async function fetchSmartRecruitersDescription(job) {
  const postingId = job.external_id.replace('smartrecruiters_', '');
  const res = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.ats_slug)}/postings/${postingId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    logger.warn({ jobId: job.id, slug: job.ats_slug, status: res.status }, 'SmartRecruiters API: non-200');
    return null;
  }
  const detail = await res.json();
  if (!detail?.jobAd?.sections) {
    logger.warn({ jobId: job.id, slug: job.ats_slug, hasJobAd: !!detail?.jobAd }, 'SmartRecruiters: no jobAd.sections');
    return null;
  }
  const parts = [];
  for (const section of Object.values(detail.jobAd.sections)) {
    if (section.text && section.text.trim()) parts.push(section.text);
  }
  if (parts.length > 0) return parts.join('\n');

  // jobAd.sections existed and we iterated it cleanly — but every section's
  // `text` field is empty. Confirmed via direct probe: some companies
  // (e.g. AccorHotel, Dr Reddy's) use SmartRecruiters as a redirect-only
  // landing system with no body content. Mark N/A so we stop retrying.
  return 'SKIP';
}

async function fetchBambooHRDescription(job) {
  const jobId = job.external_id.replace('bamboohr_', '');
  const res = await fetch(
    `https://${job.ats_slug}.bamboohr.com/careers/${jobId}/detail`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result?.jobOpening?.description || null;
}

function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) {
        return ld.description;
      }
    } catch { /* invalid JSON-LD */ }
  }
  return null;
}

async function fetchJazzHRDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // JazzHR embeds description in the largest content div
  const divs = html.match(/<div[^>]*>((?:(?!<div).)*?)<\/div>/gs) || [];
  let best = null;
  let bestLen = 0;
  for (const div of divs) {
    const clean = div.replace(/<[^>]+>/g, '').trim();
    if (clean.length > bestLen && clean.length > 100) {
      bestLen = clean.length;
      best = div.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '').trim();
    }
  }
  return best;
}

async function fetchBreezyDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Breezy has description in og:description meta tag
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  if (ogMatch?.[1] && ogMatch[1].length > 50) return ogMatch[1];
  return null;
}

async function fetchTaleoDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Taleo server-rendered pages: description in <span class="text"> inside editablesection
  const taleoDesc = extractTaleoDescription(html);
  if (taleoDesc) return taleoDesc;
  // Extract from !*! delimited URL-encoded HTML in pipe data
  const PIPE_SEP = '!|!';
  if (html.includes('!*!') && html.includes(PIPE_SEP)) {
    const pipeStart = html.indexOf(PIPE_SEP);
    const pipeEnd = html.lastIndexOf(PIPE_SEP) + PIPE_SEP.length + 5000;
    const pipeSection = html.substring(pipeStart, Math.min(html.length, pipeEnd));
    const starParts = pipeSection.split('!*!');
    const descSegments = [];
    for (let i = 1; i < starParts.length; i++) {
      let raw = starParts[i];
      const pipeIdx = raw.indexOf(PIPE_SEP);
      if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx);
      if (raw.length < 30) continue;
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded.length > 50 && /<(p|li|br|ul|ol|div|span|h[1-6]|table|tr|td|strong|em|b|i)\b/i.test(decoded)) {
          descSegments.push(decoded);
        }
      } catch { /* skip */ }
    }
    if (descSegments.length > 0) return descSegments.join('\n');
  }
  // Try extracting from job_description div (SelectMinds redirect pages)
  const bodyDesc = extractBodyDescription(html);
  if (bodyDesc) return bodyDesc;
  return null;
}

/**
 * Extract description from Taleo server-rendered HTML.
 * Taleo uses <span class="text"> inside class="editablesection" for the main description.
 * We find the longest text span which is the job description (other spans are short metadata).
 */
function extractTaleoDescription(html) {
  if (!html || !html.includes('editablesection')) return null;
  // Find the editablesection block
  const sectionMatch = html.match(/class="editablesection"[^>]*>([\s\S]*?)<\/div>\s*<div class="staticcontentlinepanel"/i);
  if (sectionMatch?.[1] && sectionMatch[1].length > 100) return sectionMatch[1].trim();
  // Fallback: grab all <span class="text"> elements and use the longest one
  const textSpans = [];
  const spanRegex = /class="text"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = spanRegex.exec(html)) !== null) {
    if (m[1] && m[1].length > 200) textSpans.push(m[1]);
  }
  if (textSpans.length > 0) {
    textSpans.sort((a, b) => b.length - a.length);
    return textSpans[0].trim();
  }
  return null;
}

/**
 * Extract description from Oracle CX rendered HTML (Knockout.js).
 * Oracle uses multiple div.job-details__description-content sections for
 * description, responsibilities, and qualifications.
 */
function extractOracleRenderedDescription(html) {
  if (!html || !html.includes('job-details__description-content')) return null;
  const sections = [];
  const sectionRegex = /class="job-details__description-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|$)/gi;
  let m;
  while ((m = sectionRegex.exec(html)) !== null) {
    const content = m[1].trim();
    if (content.length > 50) sections.push(content);
  }
  return sections.length > 0 ? sections.join('\n') : null;
}

// Oracle tenants known to have no public descriptions (empty API + empty rendered HTML)
const ORACLE_SKIP_TENANTS = new Set(['hcbt']);

async function fetchOracleDescription(job) {
  // Parse tenant.region.siteNumber from ats_slug
  const parts = job.ats_slug.split('.');
  if (parts.length < 2) {
    logger.debug({ jobId: job.id, slug: job.ats_slug }, 'Oracle: slug has < 2 parts');
    return null;
  }
  const tenant = parts[0];
  const region = parts[1];

  if (ORACLE_SKIP_TENANTS.has(tenant)) {
    return 'SKIP';
  }
  const siteNumber = parts.slice(2).join('.') || null;
  if (!siteNumber) {
    logger.debug({ jobId: job.id, slug: job.ats_slug }, 'Oracle: no siteNumber in slug');
    return null;
  }
  const jobId = job.external_id.replace('oracle_', '');

  // Strategy 1: REST API (fast, no proxy needed)
  let apiStatus = null;
  try {
    const url = `https://${tenant}.fa.${region}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${siteNumber}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    apiStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        const descParts = [
          item.ExternalDescriptionStr,
          item.ExternalQualificationsStr,
          item.ExternalResponsibilitiesStr,
          item.CorporateDescriptionStr,
          item.OrganizationDescriptionStr,
          item.ShortDescriptionStr,
        ].filter(Boolean);
        if (descParts.length > 0) return descParts.join('\n');
        logger.warn({ jobId: job.id, slug: job.ats_slug }, 'Oracle API: 200 but all description fields empty');
      } else {
        logger.warn({ jobId: job.id, slug: job.ats_slug }, 'Oracle API: 200 but no items returned');
      }
    } else {
      logger.warn({ jobId: job.id, slug: job.ats_slug, status: apiStatus }, 'Oracle API: non-200 response');
    }
  } catch (err) {
    logger.warn({ jobId: job.id, slug: job.ats_slug, err: err.message, apiStatus }, 'Oracle API: request failed');
  }

  // Strategy 2: Render page via proxy and extract from Knockout.js-rendered HTML
  if (job.url) {
    try {
      const html = await fetchUnlockedHtml(job.url);
      const htmlLen = html?.length || 0;
      const hasDescContent = html?.includes('job-details__description-content') || false;
      const oracleDesc = extractOracleRenderedDescription(html);
      if (oracleDesc) return oracleDesc;
      logger.warn({ jobId: job.id, slug: job.ats_slug, htmlLen, hasDescContent }, 'Oracle proxy: rendered but extraction failed');
    } catch (err) {
      logger.warn({ jobId: job.id, slug: job.ats_slug, err: err.message }, 'Oracle proxy: fetch failed');
    }
  }

  return null;
}

async function fetchGreenhouseDescription(job) {
  const jobId = job.external_id.replace('greenhouse_', '');
  const res = await fetch(
    `https://api.greenhouse.io/v1/boards/${encodeURIComponent(job.ats_slug)}/jobs/${jobId}?questions=true`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.content || null;
}

async function fetchLeverDescription(job) {
  const jobId = job.external_id.replace('lever_', '');
  const res = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(job.ats_slug)}/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();

  // Lever postings split body content across several fields. The legacy fetcher
  // only checked descriptionPlain/description, so postings where the content was
  // in descriptionBodyPlain/opening/lists got marked as failed forever.
  // Build the full description from every populated section.
  const parts = [];
  const append = (s) => { if (typeof s === 'string' && s.trim()) parts.push(s.trim()); };

  append(data.openingPlain || data.opening);
  append(data.descriptionPlain || data.description);
  append(data.descriptionBodyPlain || data.descriptionBody);

  if (Array.isArray(data.lists)) {
    for (const list of data.lists) {
      const heading = list?.text || '';
      const body    = list?.content || '';  // 'content' is HTML; we keep it as-is
      const combined = [heading, body].filter(Boolean).join('\n');
      if (combined) parts.push(combined);
    }
  }

  append(data.additionalPlain || data.additional);

  const full = parts.join('\n\n').trim();
  if (full) return full;

  // We successfully got a 200 + parsed response, but every text field is empty.
  // These postings (often used as redirect landing pages) genuinely have no body.
  // Mark them N/A so we stop retrying every cycle forever.
  return 'SKIP';
}

async function fetchAshbyDescription(job) {
  const jobId = job.external_id.replace('ashby_', '');
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(job.ats_slug)}/job/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.descriptionHtml || data.descriptionPlain || null;
}

async function fetchIcimsDescription(job) {
  const externalId = job.external_id.replace('icims_', '');
  // iCIMS iframe endpoint returns server-rendered HTML with JSON-LD
  const url = `https://${job.ats_slug}.icims.com/jobs/${externalId}/job?in_iframe=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    // Extract description from JSON-LD (most reliable)
    const ld = extractJsonLdDescription(html);
    if (ld) return ld;
  } catch { /* timeout or network error */ }
  return null;
}

async function fetchPersonioDescription(job) {
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.jobs.personio.de/xml`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return null;
  const xml = await res.text();
  const positionId = job.external_id.replace('personio_', '');
  // Find the position block with matching ID
  const posRegex = new RegExp(`<position>([\\s\\S]*?)</position>`, 'g');
  let posMatch;
  while ((posMatch = posRegex.exec(xml)) !== null) {
    const block = posMatch[1];
    const idMatch = block.match(/<id>(\d+)<\/id>/);
    if (idMatch && idMatch[1] === positionId) {
      // Extract CDATA descriptions
      const sections = [];
      const descRegex = /<jobDescription>[\s\S]*?<name><!\[CDATA\[(.*?)\]\]><\/name>[\s\S]*?<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>[\s\S]*?<\/jobDescription>/g;
      let descMatch;
      while ((descMatch = descRegex.exec(block)) !== null) {
        sections.push(`<h3>${descMatch[1]}</h3>${descMatch[2]}`);
      }
      if (sections.length > 0) return sections.join('\n');
    }
  }
  return null;
}

async function fetchRecruiteeDescription(job) {
  const jobId = job.external_id.replace('recruitee_', '');
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.recruitee.com/api/offers/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.offer?.description || data.description || null;
}

async function fetchRipplingDescription(job) {
  const jobUuid = job.external_id.replace('rippling_', '');
  const res = await fetch(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(job.ats_slug)}/jobs/${jobUuid}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const desc = data.description;
  if (!desc) return null;
  const parts = [desc.company, desc.role, desc.compensation].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchZohoDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
  // Some Zoho tenants use a JS-only SPA template (HTML body ~2KB, no embedded
  // data). No regex match means we can't extract anything without a real
  // browser — mark SKIP so we don't retry these forever.
  if (!match) return 'SKIP';
  // Zoho's embedded JSON uses \xNN hex escapes for many characters (&, ', ", /, etc.).
  // The legacy unescaper only handled \x22 and \x27, so any payload containing
  // \x26 (&) or other hex codes broke JSON.parse — root cause of 308 zoho rows
  // missing descriptions. Decode all \xNN sequences generically.
  let raw = match[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Zoho also emits non-standard JSON escapes like "2026\-04\-21" (backslash
  // followed by an arbitrary character). JSON only allows \", \\, \/, \b, \f,
  // \n, \r, \t, \uXXXX — anything else trips JSON.parse. Strip those stray
  // backslashes, keeping the valid escapes intact.
  raw = raw.replace(/\\([^"\\/bfnrtu])/g, '$1');
  // Legacy double-escape cleanup (kept for payloads that embed JSON-in-JSON).
  raw = raw.replace(/\\\\"/g, '\\"').replace(/\\\\:/g, ':').replace(/\\\\\//g, '/');
  try {
    const parsed = JSON.parse(raw);
    const jobData = Array.isArray(parsed) ? parsed[0] : parsed;
    const desc = jobData?.Job_Description;
    if (typeof desc !== 'string') return null;            // unexpected shape, retry later
    if (desc.trim() === '') return 'SKIP';                // upstream-empty, stop retrying
    return desc;
  } catch {
    // Last-ditch: try a regex extract for just the Job_Description field
    // (handles cases where some other field has weird encoding we missed).
    const descMatch = raw.match(/"Job_Description"\s*:\s*"([\s\S]*?)"\s*,\s*"/);
    if (descMatch) {
      const desc = descMatch[1].replace(/\\"/g, '"');
      if (desc.trim()) return desc;
      return 'SKIP'; // matched but empty
    }
    // Both JSON.parse and regex fallback failed — this tenant uses a format
    // we can't handle. SKIP rather than retrying forever.
    return 'SKIP';
  }
}

async function fetchWorkableDescription(job) {
  const shortcode = job.external_id.replace('workable_', '');
  const res = await fetch(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(job.ats_slug)}/jobs/${shortcode}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const parts = [data.description, data.requirements, data.benefits].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchJobviteDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  return ogMatch?.[1]?.length > 50 ? ogMatch[1] : null;
}

async function fetchComeetDescription(job) {
  const positionUid = job.external_id.replace('comeet_', '');
  const slugParts = job.ats_slug.split(':');
  if (slugParts.length < 2) return null;
  const [uid, ...tokenParts] = slugParts;
  const token = tokenParts.join(':');
  const res = await fetch(
    `https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(uid)}/positions/${encodeURIComponent(positionUid)}?token=${encodeURIComponent(token)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.details?.description || data.description || null;
}

async function fetchPinpointDescription(job) {
  const jobId = job.external_id.replace('pinpoint_', '');
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.pinpointhq.com/postings/${jobId}.json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const sections = [];
  if (data.description) sections.push(data.description);
  if (data.key_responsibilities) {
    const header = data.key_responsibilities_header || 'Key Responsibilities';
    sections.push(`<h3>${header}</h3>${data.key_responsibilities}`);
  }
  if (data.skills_knowledge_expertise) {
    const header = data.skills_knowledge_expertise_header || 'Skills, Knowledge and Expertise';
    sections.push(`<h3>${header}</h3>${data.skills_knowledge_expertise}`);
  }
  if (data.benefits) {
    const header = data.benefits_header || 'Benefits';
    sections.push(`<h3>${header}</h3>${data.benefits}`);
  }
  return sections.length > 0 ? sections.join('\n') : null;
}

async function fetchSuccessFactorsDescription(job) {
  if (!job.url) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  return null;
}

/**
 * Extract job description from page body HTML using common CSS selectors.
 * Targets well-known job description container classes/IDs.
 */
function extractBodyDescription(html) {
  if (!html) return null;

  // Oracle CX rendered pages (Knockout.js)
  const oracleDesc = extractOracleRenderedDescription(html);
  if (oracleDesc) return oracleDesc;

  // Taleo server-rendered pages
  const taleoDesc = extractTaleoDescription(html);
  if (taleoDesc) return taleoDesc;

  // Common job description selectors (class or id)
  const patterns = [
    /class="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /id="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /id="description[_-]?box"[^>]*>([\s\S]*?)<\/div>/i,
    /class="job[_-]?details?[_-]?content"[^>]*>([\s\S]*?)<\/div>/i,
    /class="posting[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /data-testid="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1] && m[1].length > 100) return m[1].trim();
  }
  return null;
}

/**
 * Extract description from raw HTML using multiple strategies:
 * 1. JSON-LD JobPosting schema
 * 2. Page body (job_description divs)
 * 3. og:description meta tag
 * 4. meta description tag
 */
function extractDescriptionFromHtml(html) {
  if (!html) return null;
  // 1. JSON-LD (most reliable)
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // 2. Page body (job description divs)
  const bodyDesc = extractBodyDescription(html);
  if (bodyDesc) return bodyDesc;
  // 3. og:description (often has full job description)
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i)
    || html.match(/content="([^"]*)"[^>]*property="og:description"/i);
  if (ogMatch?.[1] && ogMatch[1].length > 100) return ogMatch[1];
  // 4. meta description
  const metaMatch = html.match(/name="description"[^>]*content="([^"]*)"/i)
    || html.match(/content="([^"]*)"[^>]*name="description"/i);
  if (metaMatch?.[1] && metaMatch[1].length > 100) return metaMatch[1];
  return null;
}


async function fetchDescription(job) {
  const rawData = typeof job.raw_data === 'string' ? JSON.parse(job.raw_data) : job.raw_data;

  // Try ATS-specific fetcher first
  let description = null;
  switch (job.ats) {
    case 'workday':
      description = await fetchWorkdayDescription(job, rawData); break;
    case 'taleo':
      description = await fetchTaleoDescription(job); break;
    case 'oracle':
      description = await fetchOracleDescription(job); break;
    case 'smartrecruiters':
      description = await fetchSmartRecruitersDescription(job); break;
    case 'bamboohr':
      description = await fetchBambooHRDescription(job); break;
    case 'jazzhr':
      description = await fetchJazzHRDescription(job); break;
    case 'breezy':
      description = await fetchBreezyDescription(job); break;
    case 'greenhouse':
      description = await fetchGreenhouseDescription(job); break;
    case 'lever':
      description = await fetchLeverDescription(job); break;
    case 'ashby':
      description = await fetchAshbyDescription(job); break;
    case 'icims':
      description = await fetchIcimsDescription(job); break;
    case 'personio':
      description = await fetchPersonioDescription(job); break;
    case 'recruitee':
      description = await fetchRecruiteeDescription(job); break;
    case 'rippling':
      description = await fetchRipplingDescription(job); break;
    case 'zoho':
      description = await fetchZohoDescription(job); break;
    case 'workable':
      description = await fetchWorkableDescription(job); break;
    case 'pinpoint':
      description = await fetchPinpointDescription(job); break;
    case 'successfactors':
      description = await fetchSuccessFactorsDescription(job); break;
    case 'comeet':
      description = await fetchComeetDescription(job); break;
  }

  // No Browserless proxy fallback — all active ATS platforms return descriptions
  // via their own APIs. If the ATS fetcher returned nothing, we just retry next cycle.
  return description;
}

/**
 * Process a single job — fetch description and update DB.
 * Returns 'filled' or 'failed'.
 */
async function processJob(job, ats) {
  try {
    const description = await fetchDescription(job);
    if (description === 'SKIP') {
      // Tenant has no public descriptions — mark as unavailable so we stop retrying
      await query("UPDATE jobs SET description = 'N/A' WHERE id = ?", [job.id]);
      return 'skipped';
    }
    if (description) {
      await query('UPDATE jobs SET description = ? WHERE id = ?', [description, job.id]);
      metrics.increment(`backfill.filled.${ats}`);
      return 'filled';
    } else {
      // Leave description as NULL so it gets retried next cycle
      metrics.increment(`backfill.failed.${ats}`);
      return 'failed';
    }
  } catch (err) {
    // Leave description as NULL so it gets retried next cycle
    metrics.increment(`backfill.failed.${ats}`);
    logger.warn({ jobId: job.id, ats: job.ats, slug: job.ats_slug, err: err.message }, 'Backfill fetch failed');
    return 'failed';
  }
}

/**
 * Run jobs concurrently with a pool of N workers.
 */
async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function backfillForAts(ats, batchSize, concurrency) {
  const { rows: jobs } = await query(
    `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, c.ats_slug
     FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.removed_at IS NULL
     AND j.description IS NULL
     AND j.ats = ?
     ORDER BY j.first_seen_at DESC
     LIMIT ?`,
    [ats, batchSize]
  );

  if (jobs.length === 0) return { filled: 0, failed: 0 };

  const results = await runWithConcurrency(jobs, concurrency, (job) => processJob(job, ats));

  const filled = results.filter(r => r === 'filled').length;
  const failed = results.filter(r => r === 'failed').length;

  return { filled, failed };
}

async function backfillDescriptions() {
  logger.info('Description backfill: starting');

  // Run all ATS platforms in parallel — each has its own rate limiting via delayMs
  const results = await Promise.allSettled(
    Object.entries(ATS_CONFIG).map(async ([ats, cfg]) => {
      const { filled, failed } = await backfillForAts(ats, cfg.batchSize, cfg.concurrency);
      if (filled > 0 || failed > 0) {
        logger.info({ ats, filled, failed }, 'Description backfill: ATS batch done');
      }
      return { ats, filled, failed };
    })
  );

  let totalFilled = 0;
  let totalFailed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalFilled += r.value.filled;
      totalFailed += r.value.failed;
    } else {
      logger.error({ err: r.reason?.message }, 'Description backfill: ATS batch error');
    }
  }

  logger.info({ filled: totalFilled, failed: totalFailed }, 'Description backfill: complete');
  return totalFilled;
}

module.exports = { backfillDescriptions, fetchDescription, backfillForAts, ATS_CONFIG };
