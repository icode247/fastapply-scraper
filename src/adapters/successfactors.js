/**
 * SuccessFactors (SAP) adapter — modern Career Site Builder (CSB) sites.
 *
 * CSB career sites live on each company's own host (jobs.acme.com, careers.acme.com,
 * {tenant}.jobs.hr.cloud.sap, ...) and every one publishes /sitemap.xml. Two shapes:
 *   1. Google-Jobs RSS  (<rss>/<item> with g:location, g:employer, g:id, full description
 *      inline) — no per-job fetch needed.
 *   2. urlset  (<loc> .../job/{id}/ URLs) — fetch each job page and read schema.org
 *      MICRODATA (<meta itemprop="datePosted|hiringOrganization|addressLocality...">) plus
 *      og:title and the jobDisplay description div.
 *
 * `clientname` MUST be the career-site HOST (e.g. "jobs.grainger.com"), NOT a short slug.
 * The old adapter keyed off `career{slug}.successfactors.eu` with slugs that were actually
 * junk subdomain labels ("jobs", "careers"), so it fetched nothing. Company rows now store
 * the host as ats_slug (derived from career_url).
 */
const logger = require('../logger');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DETAIL_BATCH_SIZE = 5;
const MAX_JOBS = 2000; // safety cap per company (avoid pathological detail-fetch storms)

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function isoDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function jobIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/(\d{4,})\/?(?:[?#].*)?$/);
  return m ? m[1] : url.split('/').filter(Boolean).pop() || null;
}

async function fetchText(url, timeout = 15000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    text: res.ok ? await res.text() : '',
  };
}

// schema.org microdata: <meta itemprop="X" content="Y"> (either attribute order)
function microdataAttr(html, prop) {
  const m = html.match(new RegExp(`itemprop=["']${prop}["'][^>]*?content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`content=["']([^"']*)["'][^>]*?itemprop=["']${prop}["']`, 'i'));
  return m ? m[1].trim() : null;
}

function metaProperty(html, prop) {
  const m = html.match(new RegExp(`property=["']${prop}["'][^>]*?content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`content=["']([^"']*)["'][^>]*?property=["']${prop}["']`, 'i'));
  return m ? m[1].trim() : null;
}

function extractJobDisplay(html) {
  const start = html.search(/<div[^>]*class=["'][^"']*\bjobDisplay\b[^"']*["'][^>]*>/i);
  if (start === -1) return null;
  let chunk = html.slice(start, start + 60000);
  const cut = chunk.slice(300).search(/<div[^>]*(id=["']sharingwidget["']|class=["'][^"']*(jobShare|similarJobs|jobFooter|footer)[^"']*["'])/i);
  if (cut > -1) chunk = chunk.slice(0, cut + 300);
  return chunk.trim() || null;
}

async function fetchDetail(url) {
  try {
    const { ok, text } = await fetchText(url, 15000);
    if (!ok) return null;
    const rawTitle = metaProperty(text, 'og:title') || (text.match(/<title>([^<]*)<\/title>/i)?.[1] || '');
    const title = rawTitle.replace(/\s*Job Details.*$/i, '').replace(/\s*\|\s*[^|]*$/, '').trim() || null;
    const location = [microdataAttr(text, 'addressLocality'), microdataAttr(text, 'addressRegion'), microdataAttr(text, 'addressCountry')]
      .filter(Boolean).join(', ') || null;
    return {
      title,
      location,
      employment_type: microdataAttr(text, 'employmentType'),
      posted_at: isoDate(microdataAttr(text, 'datePosted')),
      company: microdataAttr(text, 'hiringOrganization'),
      description: extractJobDisplay(text),
    };
  } catch {
    return null;
  }
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const jobs = [];
  for (const [, it] of items) {
    const tag = (t) => { const m = it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? decodeEntities(m[1]).trim() : null; };
    const gtag = (t) => { const m = it.match(new RegExp(`<g:${t}[^>]*>([\\s\\S]*?)</g:${t}>`, 'i')); return m ? decodeEntities(m[1]).trim() : null; };
    const url = tag('link');
    const title = tag('title');
    if (!url || !title) continue;
    jobs.push({
      external_id: `successfactors_${gtag('id') || jobIdFromUrl(url)}`,
      title,
      department: (gtag('job_function') || '').replace(/\s*\(\d+\)\s*$/, '').trim() || null,
      location: gtag('location') || null,
      workplace_type: null,
      employment_type: gtag('employment_type') || null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: tag('description') || null,
      url,
      posted_at: isoDate(gtag('date_posted')),
      raw_data: { source: 'rss', company: gtag('employer') || null },
    });
  }
  return jobs;
}

// Follow one level of sitemap-index if the root sitemap only points to sub-sitemaps.
async function collectJobUrls(xml, depth = 0) {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => decodeEntities(m[1]).trim());
  const jobLocs = locs.filter(u => /\/job\//i.test(u));
  if (jobLocs.length || depth > 0) return jobLocs;
  const subSitemaps = locs.filter(u => /\.xml(\?|$)/i.test(u)).slice(0, 25);
  const all = [];
  for (const s of subSitemaps) {
    try {
      const { ok, text } = await fetchText(s, 15000);
      if (ok) all.push(...await collectJobUrls(text, 1));
    } catch { /* skip bad sub-sitemap */ }
    if (all.length >= MAX_JOBS) break;
  }
  return all;
}

async function fetchJobs(clientname) {
  const host = String(clientname || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
  if (!host || !host.includes('.')) {
    throw new Error(`SuccessFactors: invalid career host "${clientname}" (expected e.g. jobs.acme.com)`);
  }

  const { ok, status, contentType, text } = await fetchText(`https://${host}/sitemap.xml`, 20000);
  if (!ok) throw new Error(`SuccessFactors: sitemap HTTP ${status} for ${host}`);
  if (!/xml/i.test(contentType) && !/^\s*(<\?xml|<urlset|<rss|<sitemapindex)/i.test(text)) {
    throw new Error(`SuccessFactors: ${host} sitemap not XML (${contentType || 'unknown'})`);
  }

  // RSS (Google-Jobs) — everything inline, no per-job fetch.
  if (/<rss[\s>]|<item>/i.test(text)) {
    const jobs = parseRss(text).slice(0, MAX_JOBS);
    return { jobs, meta: { companyName: jobs.find(j => j.raw_data.company)?.raw_data.company || null } };
  }

  // urlset — enumerate job URLs, then fetch schema.org microdata per job.
  const urls = (await collectJobUrls(text)).slice(0, MAX_JOBS);
  if (!urls.length) throw new Error(`SuccessFactors: no job URLs found in sitemap for ${host}`);

  const jobs = [];
  for (let i = 0; i < urls.length; i += DETAIL_BATCH_SIZE) {
    const batch = urls.slice(i, i + DETAIL_BATCH_SIZE);
    const details = await Promise.all(batch.map(u => fetchDetail(u).then(d => ({ u, d }))));
    for (const { u, d } of details) {
      if (!d || !d.title) continue;
      jobs.push({
        external_id: `successfactors_${jobIdFromUrl(u)}`,
        title: d.title,
        department: null,
        location: d.location,
        workplace_type: null,
        employment_type: d.employment_type,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: d.description,
        url: u,
        posted_at: d.posted_at,
        raw_data: { source: 'sitemap', company: d.company },
      });
    }
  }

  if (urls.length >= MAX_JOBS) logger.warn({ host, cap: MAX_JOBS }, 'SuccessFactors: job list truncated at cap');
  return { jobs, meta: { companyName: jobs.find(j => j.raw_data.company)?.raw_data.company || null } };
}

module.exports = { fetchJobs };
