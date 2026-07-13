/**
 * iCIMS adapter.
 * Supports two types of iCIMS career sites:
 * 1. Jibe-powered sites with /api/jobs JSON endpoint
 * 2. Classic iCIMS portals at {slug}.icims.com with HTML scraping
 *
 * Classic portals use consistent CSS classes:
 * - .iCIMS_JobsTable container
 * - .iCIMS_Anchor links with title="ID - Job Title"
 * - Pagination via ?pr=N (0-indexed)
 * - Detail pages have .iCIMS_Header, .iCIMS_JobHeaderData, .iCIMS_Expandable_Text
 */
const logger = require('../logger');

const DETAIL_BATCH_SIZE = 5;
const MAX_PAGES = 50;

async function fetchJobs(clientname) {
  // Build URL candidates based on slug format
  const urls = [];

  if (clientname.includes('-')) {
    urls.push(`https://${clientname}.icims.com/api/jobs`);
    const parts = clientname.split('-');
    if (['careers', 'jobs', 'globalcareers'].includes(parts[0])) {
      const company = parts.slice(1).join('-');
      urls.push(`https://careers.${company}.com/api/jobs`);
      urls.push(`https://jobs.${company}.com/api/jobs`);
    }
  } else {
    urls.push(`https://careers.${clientname}.com/api/jobs`);
    urls.push(`https://jobs.${clientname}.com/api/jobs`);
    urls.push(`https://${clientname}.icims.com/api/jobs`);
  }

  // Try Jibe-powered JSON endpoints first
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) continue;
      const text = await res.text();
      if (text.startsWith('{') || text.startsWith('[')) {
        const data = JSON.parse(text);
        if (data.jobs && Array.isArray(data.jobs)) {
          return parseJibeResponse(data, url.replace('/api/jobs', ''));
        }
      }
    } catch { /* try next */ }
  }

  // Fallback: scrape classic iCIMS HTML portal
  const portalUrl = `https://${clientname}.icims.com`;
  const jobs = await scrapeClassicPortal(portalUrl, clientname);
  if (jobs.length > 0) {
    return { jobs, meta: { companyName: null, logoUrl: null } };
  }

  throw new Error(`iCIMS: no working endpoint found for ${clientname}`);
}

function parseJibeResponse(data, baseUrl) {
  const jobs = (data.jobs || []).map(entry => {
    const job = entry.data || entry;
    return {
      external_id: `icims_${job.req_id || job.slug}`,
      title: job.title,
      department: job.categories?.[0]?.name || null,
      location: job.full_location || job.short_location || job.location_name || null,
      workplace_type: (job.tags2 || []).some(t => t.toLowerCase().includes('remote')) ? 'remote' : null,
      employment_type: job.employment_type?.replace('_', ' ') || null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: [job.description, job.responsibilities, job.qualifications].filter(Boolean).join('\n'),
      url: job.apply_url || `${baseUrl}/jobs/${job.slug}`,
      posted_at: job.posted_date || job.create_date || null,
      raw_data: job,
    };
  });

  const firstJob = data.jobs?.[0]?.data || {};
  return {
    jobs,
    meta: {
      companyName: firstJob.hiring_organization || null,
      logoUrl: firstJob.hiring_organization_logo || null,
    },
  };
}

/**
 * Scrape classic iCIMS portal. Uses consistent CSS class patterns:
 * - Links: <a class="iCIMS_Anchor" title="ID - Title" href="/jobs/ID/...">
 * - Pagination: ?pr=0, ?pr=1, etc.
 */
async function scrapeClassicPortal(portalUrl, clientname) {
  const allJobs = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchUrl = `${portalUrl}/jobs/search?ss=1&searchKeyword=&searchLocation=&mobile=false&listFilterMode=1&in_iframe=1&pr=${page}`;

    let html;
    try {
      const res = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        if (page === 0) throw new Error(`iCIMS classic HTTP ${res.status}`);
        break;
      }
      html = await res.text();
    } catch (err) {
      if (page === 0) throw err;
      break;
    }

    // Verify it's an iCIMS portal (page 0 only)
    if (page === 0 && !html.includes('iCIMS') && !html.includes('icims')) {
      throw new Error('Not an iCIMS portal');
    }

    // Extract jobs using iCIMS_Anchor pattern: title="ID - Job Title"
    const jobs = extractJobsFromPage(html, portalUrl);
    if (jobs.length === 0) break;

    let newOnPage = 0;
    for (const job of jobs) {
      if (!seen.has(job.external_id)) {
        seen.add(job.external_id);
        allJobs.push(job);
        newOnPage++;
      }
    }

    // If no new jobs found, we've exhausted pagination
    if (newOnPage === 0) break;

    // Rate limit between pages
    if (page < MAX_PAGES - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Fetch details in batches for descriptions
  if (allJobs.length > 0) {
    await enrichWithDetails(allJobs, portalUrl);
  }

  logger.info({ clientname, jobs: allJobs.length, source: 'classic' }, 'iCIMS classic portal scraped');
  return allJobs;
}

/**
 * Extract jobs from a single iCIMS search results page.
 */
function extractJobsFromPage(html, portalUrl) {
  const jobs = [];

  // Pattern 1: iCIMS_Anchor with title="ID - Job Title"
  const anchorRegex = /<a[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*title="(\d+)\s*-\s*([^"]+)"[^>]*href="([^"]+)"/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const jobId = match[1];
    const title = match[2].trim();
    const href = match[3];
    const fullUrl = href.startsWith('http') ? href : `${portalUrl}${href}`;

    jobs.push({
      external_id: `icims_${jobId}`,
      title,
      department: null, location: null, workplace_type: null, employment_type: null,
      salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
      description: null, url: fullUrl.split('?')[0],
      posted_at: null, raw_data: { id: jobId },
    });
  }

  // Pattern 2: Fallback — any link to /jobs/{id}/
  if (jobs.length === 0) {
    const linkRegex = /href="([^"]*\/jobs\/(\d+)[^"]*)"/gi;
    const titleRegex = /title="([^"]+)"/i;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const jobId = match[2];

      // Try to find title from the same anchor tag
      let title = `Job ${jobId}`;
      const tagStart = html.lastIndexOf('<a', match.index);
      if (tagStart >= 0) {
        const tag = html.substring(tagStart, match.index + match[0].length + 200);
        const tm = tag.match(titleRegex);
        if (tm) {
          const t = tm[1].replace(/^\d+\s*-\s*/, '').trim();
          if (t.length > 2) title = t;
        }
      }

      const fullUrl = href.startsWith('http') ? href : `${portalUrl}${href}`;
      jobs.push({
        external_id: `icims_${jobId}`,
        title,
        department: null, location: null, workplace_type: null, employment_type: null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: null, url: fullUrl.split('?')[0],
        posted_at: null, raw_data: { id: jobId },
      });
    }
  }

  return jobs;
}

/**
 * Fetch job detail pages to extract descriptions, departments, locations.
 * Detail pages have structured HTML with iCIMS CSS classes.
 */
async function enrichWithDetails(jobs, portalUrl) {
  for (let i = 0; i < jobs.length; i += DETAIL_BATCH_SIZE) {
    const batch = jobs.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(job => fetchJobDetail(job.url))
    );

    for (let j = 0; j < batch.length; j++) {
      const detail = settled[j].status === 'fulfilled' ? settled[j].value : null;
      if (!detail) continue;

      if (detail.title) batch[j].title = detail.title;
      if (detail.description) batch[j].description = detail.description;
      if (detail.department) batch[j].department = detail.department;
      if (detail.location) batch[j].location = detail.location;
      if (detail.employment_type) batch[j].employment_type = detail.employment_type;
    }

    if (i + DETAIL_BATCH_SIZE < jobs.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function fetchJobDetail(url) {
  try {
    // iCIMS detail pages are iframe wrappers — the actual content lives at ?in_iframe=1
    const detailUrl = url.includes('?') ? `${url}&in_iframe=1` : `${url}?in_iframe=1`;
    const res = await fetch(detailUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Title from <h1 class="iCIMS_Header">
    let title = null;
    const titleMatch = html.match(/<h1[^>]*class="[^"]*iCIMS_Header[^"]*"[^>]*>([^<]+)/i);
    if (titleMatch) title = titleMatch[1].trim();

    // Metadata from <dt>...<dd class="iCIMS_JobHeaderData"> pairs
    // Labels may be plain text in <dt> OR inside <span class="sr-only"> within <dt>
    // Values are typically inside a <span> within the <dd>
    const meta = {};
    const pairRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*class="[^"]*iCIMS_JobHeaderData[^"]*"[^>]*>([\s\S]*?)<\/dd>/gi;
    let m;
    while ((m = pairRegex.exec(html)) !== null) {
      // Extract label: try sr-only span first, then plain text
      let label = '';
      const srMatch = m[1].match(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>([^<]+)/i);
      if (srMatch) {
        label = srMatch[1].trim();
      } else {
        label = m[1].replace(/<[^>]+>/g, '').trim();
      }
      // Extract value: strip tags, get text
      const value = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (label && value) {
        meta[label.toLowerCase()] = value;
      }
    }

    // Description from .iCIMS_Expandable_Text sections
    const descParts = [];
    const sectionRegex = /<div[^>]*class="[^"]*iCIMS_Expandable_Text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = sectionRegex.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 10) descParts.push(text);
    }

    // Try JSON-LD for structured data (description, location, employment type)
    let ld = null;
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try { ld = JSON.parse(ldMatch[1]); } catch { /* invalid JSON-LD */ }
    }

    // Fallback description from JSON-LD
    if (descParts.length === 0 && ld?.description) {
      descParts.push(ld.description.replace(/<[^>]+>/g, ' ').trim());
    }

    // Build location from meta fields or JSON-LD
    // iCIMS portals use varied field names — match any key containing "location"
    let location = null;
    const locationKey = Object.keys(meta).find(k => k.includes('location') && !k.includes('type'));
    if (locationKey) location = meta[locationKey];
    if (!location) location = meta['city'] || meta['posted locations'] || null;
    if (!location && ld?.jobLocation) {
      const jl = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation];
      const parts = jl.map(loc => {
        const addr = loc?.address;
        if (!addr) return loc?.name || null;
        return [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
      }).filter(Boolean);
      if (parts.length > 0) location = parts.join('; ');
    }

    // Employment type from meta or JSON-LD
    let employment_type = meta['type'] || meta['job type'] || meta['schedule']
      || meta['employment type'] || null;
    if (!employment_type && ld?.employmentType) {
      employment_type = Array.isArray(ld.employmentType)
        ? ld.employmentType.join(', ') : ld.employmentType;
    }

    return {
      title,
      description: descParts.length > 0 ? descParts.join('\n\n') : null,
      department: meta['category'] || meta['department'] || meta['job category']
        || (Object.keys(meta).find(k => k.includes('category') || k.includes('department'))
          ? meta[Object.keys(meta).find(k => k.includes('category') || k.includes('department'))]
          : null),
      location,
      employment_type,
    };
  } catch {
    return null;
  }
}

module.exports = { fetchJobs };
