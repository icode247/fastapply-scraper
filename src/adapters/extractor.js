/**
 * Two-strategy ATS extraction:
 * 1. Regex scan of raw HTML (fast, works for static pages)
 * 2. Direct API probing (works for JS-rendered pages — no Bright Data needed)
 */
const logger = require('../logger');

const HTML_PATTERNS = [
  { ats: 'greenhouse', regex: /(?:boards|job-boards|api|board-api)\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\/js\?for=)?([^/"'?#&\s]+)/ },
  { ats: 'greenhouse', regex: /greenhouse\.io\/[^"']*?(?:board_token|token)=([^/"'?#&\s]+)/ },
  { ats: 'ashby', regex: /ashbyhq\.com\/(?:posting-api\/job-board\/)?([^/"'?#&\s]+)/ },
  { ats: 'ashby', regex: /jobs\.ashbyhq\.com\/([^/"'?#&\s]+)/ },
  { ats: 'lever', regex: /jobs\.lever\.co\/([^/"'?#&\s]+)/ },
  { ats: 'lever', regex: /api\.lever\.co\/v0\/postings\/([^/"'?#&\s]+)/ },
  { ats: 'workable', regex: /apply\.workable\.com\/(?:api\/v[12]\/widget\/accounts\/)?([^/"'?#&\s]+)/ },
  { ats: 'recruitee', regex: /([^/"'?#&\s]+)\.recruitee\.com/ },
  { ats: 'personio', regex: /([^/"'?#&\s]+)\.jobs\.personio\.(?:de|com)/ },
  { ats: 'breezy', regex: /([^/"'?#&\s]+)\.breezy\.hr/ },
  { ats: 'jazzhr', regex: /([^/"'?#&\s]+)\.applytojob\.com/ },
  { ats: 'jazzhr', regex: /app\.jazz\.co\/widgets\/basic\/create\/([^/"'?#&\s]+)/ },
  { ats: 'workday', regex: /([^/"'?#&\s]+)\.wd\d+\.myworkdayjobs\.com/ },
  { ats: 'zoho', regex: /([^/"'?#&\s]+)\.zohorecruit\.(?:com|in|eu)/ },
  { ats: 'icims', regex: /careers\.([^/"'?#&\s]+)\.com\/api\/jobs/ },
  { ats: 'bamboohr', regex: /([^/"'?#&\s]+)\.bamboohr\.com/ },
  { ats: 'taleo', regex: /([^/"'?#&\s]+)\.taleo\.net/ },
  { ats: 'pinpoint', regex: /([^/"'?#&\s]+)\.pinpointhq\.com/ },
  { ats: 'successfactors', regex: /career([^/"'?#&\s]+)\.successfactors\.(?:eu|com)/ },
];

const FALSE_POSITIVES = new Set(['www', 'api', 'app', 'cdn', 'js', 'css', 'docs', 'support']);

function extractAtsSlugFromHtml(html) {
  for (const { ats, regex } of HTML_PATTERNS) {
    const match = html.match(regex);
    if (match && match[1] && match[1].length > 1) {
      const slug = match[1].toLowerCase();
      if (FALSE_POSITIVES.has(slug)) continue;
      return { ats, clientname: match[1] };
    }
  }
  return null;
}

/**
 * Probe known ATS APIs directly using the company's domain/name as slug.
 * Tries common slug variations (e.g., "anthropic", "anthropic-com").
 */
async function probeAtsApis(domain) {
  // Generate candidate slugs from domain
  const baseName = domain.replace(/\.com$|\.io$|\.co$|\.org$|\.net$/, '').replace(/\./g, '-');
  const slugs = [baseName, baseName.replace(/-/g, ''), domain.replace(/\./g, '-')];

  const timeout = { signal: AbortSignal.timeout(8000) };
  const probes = [
    { ats: 'greenhouse', test: (slug) => fetch(`https://api.greenhouse.io/v1/boards/${slug}/jobs`, timeout).then(r => r.ok) },
    { ats: 'ashby', test: (slug) => fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, timeout).then(r => r.ok) },
    { ats: 'lever', test: (slug) => fetch(`https://api.lever.co/v0/postings/${slug}`, timeout).then(r => r.ok) },
    { ats: 'workable', test: (slug) => fetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, timeout).then(r => r.ok) },
    { ats: 'recruitee', test: (slug) => fetch(`https://${slug}.recruitee.com/api/offers`, timeout).then(r => r.ok) },
    { ats: 'personio', test: (slug) => fetch(`https://${slug}.jobs.personio.de/search.json`, timeout).then(r => r.ok) },
    { ats: 'breezy', test: (slug) => fetch(`https://${slug}.breezy.hr/json`, timeout).then(r => r.ok) },
    { ats: 'smartrecruiters', test: (slug) => fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`, timeout).then(async r => { if (!r.ok) return false; const d = await r.json(); return d.totalFound > 0; }) },
    { ats: 'rippling', test: (slug) => fetch(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, timeout).then(r => r.ok) },
    { ats: 'bamboohr', test: (slug) => fetch(`https://${slug}.bamboohr.com/careers/list`, timeout).then(async r => { if (!r.ok) return false; const d = await r.json(); return d.result?.length > 0; }) },
    { ats: 'zoho', test: (slug) => fetch(`https://${slug}.zohorecruit.com/jobs/Careers`, timeout).then(async r => { if (!r.ok) return false; const h = await r.text(); return h.includes('id="jobs"'); }) },
    { ats: 'jazzhr', test: (slug) => fetch(`https://app.jazz.co/widgets/basic/create/${slug}`, timeout).then(async r => { if (!r.ok) return false; const h = await r.text(); return h.includes('applytojob.com'); }) },
  ];

  for (const slug of slugs) {
    for (const { ats, test } of probes) {
      try {
        const found = await test(slug);
        if (found) {
          logger.info({ ats, slug }, 'ATS found via API probe');
          return { ats, clientname: slug };
        }
      } catch {
        // Network error — skip
      }
    }
  }

  return null;
}

/**
 * Full extraction: try HTML regex first, then fall back to API probing.
 */
async function extractAtsSlug(html, domain) {
  // Strategy 1: regex on HTML
  const htmlResult = extractAtsSlugFromHtml(html);
  if (htmlResult) return htmlResult;

  // Strategy 2: probe ATS APIs directly
  if (domain) {
    return probeAtsApis(domain);
  }

  return null;
}

module.exports = { extractAtsSlug, extractAtsSlugFromHtml, probeAtsApis };
