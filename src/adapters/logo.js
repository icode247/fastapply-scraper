const logger = require('../logger');

/**
 * ATS-specific logo URL patterns.
 * Each entry is an array of regexes tried in order. First match wins.
 */
const LOGO_PATTERNS = {
  lever: [
    /https:\/\/lever-client-logos\.s3[^"'\s)]+/,
  ],
  greenhouse: [
    /https:\/\/s\d+-recruiting\.cdn\.greenhouse\.io\/external_greenhouse_job_boards\/logos\/[^"'\s)]+/,
  ],
  ashby: [
    // Ashby org-theme-logo (the actual company logo, not social/wordmark)
    /(https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-logo[^"'\s)]+)/,
    /(https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme[^"'\s)]+)/,
  ],
  workable: [
    /https:\/\/workablehr\.s3[^"'\s)]+\/uploads\/account\/logo\/[^"'\s)]+/,
  ],
  recruitee: [
    /https:\/\/careers\.recruiteecdn\.com\/image\/upload\/[^"'\s)]+/,
  ],
  smartrecruiters: [
    /https:\/\/c\.smartrecruiters\.com\/sr-company-logo[^"'\s)]+/,
    /https:\/\/c\.smartrecruiters\.com\/sr-careersite-image[^"'\s)]+/,
  ],
  rippling: [],
  personio: [
    /(https:\/\/assets\.cdn\.personio\.de\/logos\/[^"'\s)]+)/,
  ],
  breezy: [
    /(https:\/\/gallery-cdn\.breezy\.hr\/[^"'\s)]+)/,
  ],
  jazzhr: [
    /src="([^"]*s3\.amazonaws\.com\/resumator[^"]*logo[^"]*)"/i,
  ],
  workday: [],
  zoho: [
    /(https:\/\/[^"'\s)]*zohorecruit[^"'\s)]*viewCareerImage[^"'\s)]+)/,
  ],
  icims: [
    // iCIMS AppInert servlet logo (hosted on icims CDN)
    /(https?:\/\/[^"'\s)]*icims[^"'\s)]*servlet\/icims2\?module=AppInert&action=download[^"'\s)]+)/i,
    // iCIMS S3 CDN logos
    /(https?:\/\/[^"'\s)]*\.i\.icims\.com\/[^"'\s)]+\.(?:png|jpg|svg))/i,
  ],
  oracle: [],
  bamboohr: [],
  taleo: [],
  pinpoint: [],
  successfactors: [],
};

/**
 * Generic patterns tried for all ATS types as fallback.
 */
const GENERIC_PATTERNS = [
  /<img[^>]*\bsrc="([^"]+)"[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"/i,
  /<img[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"[^>]*\bsrc="([^"]+)"/i,
  /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i,
  /<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i,
];

/**
 * Clearbit Logo API — returns high-quality company logos.
 * Free, no API key needed, returns proper logos (not favicons).
 */
function clearbitLogoUrl(domain) {
  return `https://logo.clearbit.com/${domain}`;
}

/**
 * Google's favicon API — last-resort fallback.
 * Returns a 128px favicon (not ideal but always works).
 */
function googleFaviconUrl(domain) {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`;
}

/**
 * Extract the real company domain from ATS-mangled domains/slugs.
 *
 * Many enterprise ATS platforms use opaque tenant IDs or prefixed slugs
 * as hostnames, so the stored `domain` is useless for logo lookups:
 *   - Oracle:  "ebqb.us2.CX.oraclecloud.com" or "fa-ewgu-saasfaprod1.ocs.CX_2001.com"
 *   - iCIMS:   "careers-snapon.icims.com" or "careers-snapon.com"
 *   - Taleo:   "cwt.taleo.net"
 *   - SuccessFactors: "careersiemens.successfactors.eu"
 *
 * This classifier attempts to recover the real company domain.
 */
function classifyCompanyDomain(ats, atsSlug, domain) {
  // ── Lever ───────────────────────────────────────────────────────
  // Domain is "jobs.lever.co" (generic) — use slug to guess real domain
  if (ats === 'lever') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── Greenhouse ──────────────────────────────────────────────────
  // Domain is "job-boards.greenhouse.io" (generic) — use slug to guess real domain
  if (ats === 'greenhouse') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── BambooHR ────────────────────────────────────────────────────
  // Domain is "{slug}.bamboohr.com" — strip the bamboohr suffix
  if (ats === 'bamboohr') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── Ashby ───────────────────────────────────────────────────────
  // Domain is "jobs.ashbyhq.com" (generic) — use slug to guess real domain
  if (ats === 'ashby') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── Workable ────────────────────────────────────────────────────
  // Domain is "apply.workable.com" (generic) — use slug
  if (ats === 'workable') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── Recruitee ───────────────────────────────────────────────────
  // Domain is "{slug}.recruitee.com" — use slug
  if (ats === 'recruitee') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── Breezy ──────────────────────────────────────────────────────
  // Domain is "{slug}.breezy.hr" — use slug
  if (ats === 'breezy') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── JazzHR ──────────────────────────────────────────────────────
  // Domain is "{slug}.applytojob.com" — use slug
  if (ats === 'jazzhr') {
    const slug = (atsSlug || '').toLowerCase().replace(/[-_]/g, '');
    if (slug) return `${slug}.com`;
    return null;
  }

  // ── iCIMS ─────────────────────────────────────────────────────
  // Slugs: "careers-snapon", "uscareers-yelp", "management-davidsonhospitality"
  // Extract the company name after the prefix, then guess domain
  if (ats === 'icims') {
    const slug = atsSlug || '';
    const companyPart = slug
      .replace(/^(?:general[-]?|us|emea|europe|international|english|carolina(?:poly)?)?careers?\d*[-]/i, '')
      .replace(/^(?:management|application|externalsp|uscareershub|careersita)[-]/i, '')
      .replace(/[-]/g, '');
    if (companyPart && companyPart !== slug) {
      return `${companyPart}.com`;
    }
    // If no prefix was stripped, still clean up .icims.com domains
    if (domain && domain.endsWith('.icims.com')) {
      const base = domain.replace('.icims.com', '').replace(/^careers[-.]?/, '');
      if (base) return `${base}.com`;
    }
  }

  // ── Oracle ────────────────────────────────────────────────────
  // Slugs: "ebqb.us2.CX", "full:fa-ewdg-saasfaprod1.fa.ocs.oraclecloud.com/CynclyJobs"
  // The domain from createFromCrawl is garbage (oraclecloud tenant hash)
  if (ats === 'oracle') {
    const isGarbageDomain = !domain || domain.includes('oraclecloud') || /CX[_\d]*\b/.test(domain)
      || domain.includes('saasfaprod') || /^[a-z]{2,4}\.[a-z]{2,3}\.[A-Z]/.test(domain)
      || /^fa-/.test(domain);
    // If domain already looks real, keep it
    if (!isGarbageDomain) return domain;

    const slug = atsSlug || '';
    // Full: pattern — extract company name from the path suffix
    // "full:fa-ewdg-saasfaprod1.fa.ocs.oraclecloud.com/CynclyJobs"
    const fullMatch = slug.match(/\/([A-Za-z][A-Za-z0-9-]+?)(?:Jobs|Careers|Career|CareerSite|Recruitment[-]?System)?$/i);
    if (fullMatch) {
      const name = fullMatch[1].replace(/[-]/g, '').toLowerCase();
      return `${name}.com`;
    }
    // Short slug with company name after dots: "Efds.em5.Ford-Model-e", "fa-ewcd-saasfaprod1.ocs.JGCGroup"
    const parts = slug.split('.');
    const lastPart = parts[parts.length - 1];
    if (lastPart && !lastPart.match(/^(CX|CX_\d+|us\d|em\d|fa|ap\d|ca\d|ocs)$/i)) {
      const name = lastPart.replace(/[-_]?(careers?|jobs?|jobsearch)$/i, '').replace(/[-_]/g, '').toLowerCase();
      if (name && name.length > 1) return `${name}.com`;
    }
    // Opaque tenant ID (e.g. eckb.us2.CX_1001) — no company info available
    // Return null so we don't use a garbage favicon
    return null;
  }

  // ── Taleo ─────────────────────────────────────────────────────
  // Domain is "cwt.taleo.net" — strip the taleo.net suffix
  if (ats === 'taleo') {
    if (domain && domain.endsWith('.taleo.net')) {
      const base = domain.replace('.taleo.net', '');
      if (base) return `${base}.com`;
    }
  }

  // ── SmartRecruiters ──────────────────────────────────────────
  // Domain is often "careers.smartrecruiters.com" (generic) or slug-based garbage
  // like "aecom2.com", "abercrombieandfi.com". Use company_name to guess real domain.
  if (ats === 'smartrecruiters') {
    // Always reclassify — SR domains are either generic (careers.smartrecruiters.com)
    // or slug-derived garbage (aecom2.com, abercrombieandfi.com)
    const slug = (atsSlug || '').replace(/\d+$/, '').toLowerCase();
    if (slug && slug.length > 2) return `${slug}.com`;
    return null;
  }

  // ── SuccessFactors ────────────────────────────────────────────
  // Domain: "careersiemens.successfactors.eu"
  if (ats === 'successfactors') {
    if (domain && domain.includes('successfactors')) {
      const base = domain.split('.')[0].replace(/^career[s]?/i, '');
      if (base) return `${base}.com`;
    }
  }

  return domain;
}

async function fetchLogoUrl(ats, atsSlug, domain) {
  const pageUrls = {
    lever: `https://jobs.lever.co/${atsSlug}`,
    greenhouse: `https://job-boards.greenhouse.io/${atsSlug}`,
    ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
    workable: `https://apply.workable.com/${atsSlug}`,
    recruitee: `https://${atsSlug}.recruitee.com`,
    smartrecruiters: `https://careers.smartrecruiters.com/${atsSlug}`,
    rippling: null, // SPA with signed URLs — use Google favicon
    personio: `https://${atsSlug}.jobs.personio.de`,
    breezy: `https://${atsSlug}.breezy.hr`,
    jazzhr: `https://${atsSlug}.applytojob.com`,
    workday: null, // Logo comes from adapter meta
    zoho: `https://${atsSlug}.zohorecruit.com/jobs/Careers`,
    icims: `https://${atsSlug}.icims.com/jobs/search`,
    oracle: null,
    bamboohr: `https://${atsSlug}.bamboohr.com/careers`,
    taleo: null,
    pinpoint: `https://${atsSlug}.pinpointhq.com`,
    successfactors: null,
  };

  const pageUrl = pageUrls[ats];

  // Try scraping the career page for logo
  if (pageUrl) {
    try {
      const res = await fetch(pageUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const html = await res.text();
        const candidates = [];

        // 1. Try ATS-specific patterns
        const atsPatterns = LOGO_PATTERNS[ats] || [];
        for (const regex of atsPatterns) {
          const match = html.match(regex);
          if (match) {
            let url = match[1] || match[0];
            if (url.startsWith('//')) url = 'https:' + url;
            else if (url.startsWith('/')) url = new URL(url, pageUrl).href;
            candidates.push(url);
          }
        }

        // 2. Try generic img/meta patterns
        for (const regex of GENERIC_PATTERNS) {
          const match = html.match(regex);
          if (match && match[1] && !match[1].includes('sr-logo/') && !match[1].includes('lever-logo')
              && !match[1].startsWith('data:')) {
            let url = match[1];
            if (url.startsWith('//')) url = 'https:' + url;
            else if (url.startsWith('/')) url = new URL(url, pageUrl).href;
            candidates.push(url);
          }
        }

        // Validate candidates — only accept URLs that return an image with decent size
        // Tiny logos (<3KB) are usually low-quality thumbnails (e.g. SmartRecruiters 47x60)
        const MIN_LOGO_BYTES = 3000;
        for (const candidateUrl of candidates) {
          try {
            const headRes = await fetch(candidateUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
            const ct = headRes.headers.get('content-type') || '';
            const cl = parseInt(headRes.headers.get('content-length') || '0', 10);
            if (headRes.ok && ct.startsWith('image/')) {
              if (cl > 0 && cl < MIN_LOGO_BYTES) {
                logger.debug({ ats, atsSlug, candidateUrl, contentLength: cl }, 'Logo candidate rejected (too small, likely low-res thumbnail)');
                continue;
              }
              logger.info({ ats, atsSlug, logoUrl: candidateUrl }, 'Logo found and validated via scrape');
              return candidateUrl;
            }
            logger.debug({ ats, atsSlug, candidateUrl, contentType: ct }, 'Logo candidate rejected (not an image)');
          } catch {
            logger.debug({ ats, atsSlug, candidateUrl }, 'Logo candidate HEAD check failed');
          }
        }
      }
    } catch (err) {
      logger.warn({ ats, atsSlug, err: err.message }, 'Failed to fetch logo from ATS page');
    }
  }

  // 3. Classify domain — extract real company domain from ATS-mangled slugs
  const realDomain = classifyCompanyDomain(ats, atsSlug, domain);
  if (realDomain && realDomain !== domain) {
    logger.info({ ats, atsSlug, oldDomain: domain, realDomain }, 'Classified real company domain');
  }
  const logoDomain = realDomain || domain;

  // 4. Clearbit Logo API — high-quality company logos
  if (logoDomain) {
    const logoUrl = clearbitLogoUrl(logoDomain);
    try {
      const res = await fetch(logoUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        logger.info({ ats, atsSlug, logoUrl }, 'Logo found via Clearbit');
        return logoUrl;
      }
    } catch { /* clearbit failed */ }
  }

  // 5. Google favicon as last-resort fallback — validate and try TLD variants
  if (logoDomain) {
    const baseName = logoDomain.replace(/\.\w+$/, ''); // strip TLD
    const candidates = [logoDomain];
    // If the classified domain is .com, try common TLD alternatives
    if (logoDomain.endsWith('.com')) {
      candidates.push(`${baseName}.io`, `${baseName}.org`, `${baseName}.co`, `${baseName}.ai`, `${baseName}.edu`, `${baseName}.net`);
    }
    for (const candidate of candidates) {
      const favUrl = googleFaviconUrl(candidate);
      try {
        const res = await fetch(favUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          // Google returns a ~726-byte generic globe icon for unknown domains
          if (buf.byteLength > 750) {
            logger.info({ ats, atsSlug, domain: candidate }, 'Favicon validated');
            return googleFaviconUrl(candidate);
          }
        }
      } catch { /* continue to next candidate */ }
    }
    // All candidates returned generic globe — use .com anyway as best guess
    return googleFaviconUrl(logoDomain);
  }

  return null;
}

module.exports = { fetchLogoUrl };
