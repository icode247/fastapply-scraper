const logger = require('../logger');

const DETAIL_BATCH_SIZE = 3;
const PIPE_SEP = '!|!';

async function discoverPortals(company) {
  try {
    const res = await fetch(
      `https://${company}.taleo.net/careersection/sitemap.jss`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const portals = [];
    const regex = /portalCode=([^&"'\s<]+)/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const code = decodeURIComponent(match[1]);
      if (!portals.includes(code)) portals.push(code);
    }
    return portals;
  } catch {
    return [];
  }
}

async function fetchJobsFromSitemap(company, portal) {
  try {
    const res = await fetch(
      `https://${company}.taleo.net/careersection/sitemap.jss?portalCode=${encodeURIComponent(portal)}&lang=en`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const jobIds = [];
    const regex = /job=([^&"'\s<]+)/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      if (!jobIds.includes(match[1])) jobIds.push(match[1]);
    }
    return jobIds;
  } catch {
    return [];
  }
}

function parsePipeData(html, jobId) {
  // Taleo embeds job data in a pipe-delimited string: ...!|!Title!|!JobId!|!Field1!|!Field1!|!...
  // Find the segment containing this jobId
  const marker = PIPE_SEP + jobId + PIPE_SEP;
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  // Get title (the field before jobId)
  const before = html.substring(Math.max(0, idx - 200), idx);
  const beforeParts = before.split(PIPE_SEP);
  const title = beforeParts[beforeParts.length - 1]?.trim() || null;

  // Get fields after jobId — field order varies by Taleo installation
  // Scan for patterns to identify field types
  const after = html.substring(idx + marker.length, idx + marker.length + 2000);
  const parts = after.split(PIPE_SEP);

  let location = null;
  let department = null;
  let schedule = null;

  for (let i = 0; i < Math.min(parts.length, 20); i++) {
    const v = parts[i]?.trim();
    if (!v) continue;

    // Location: contains country-region pattern like "UK-England-York" or "Belgium-Brussels"
    if (!location && v.match(/^[A-Z]{2}-/)) {
      location = v;
      // Check for "Other Locations" 2 positions later
      const other = parts[i + 2]?.trim();
      if (other && other.match(/^[A-Z]{2}-|,/)) {
        location = location + '; ' + other;
      }
      continue;
    }

    // Schedule: Full-time, Part-time, Contractor, etc.
    if (!schedule && v.match(/^(Full-time|Part-time|Contractor|Temporary|Intern|Casual)/i)) {
      schedule = v;
      continue;
    }

    // Department: longer strings that aren't dates or numbers
    if (!department && v.length > 5 && !v.match(/^\d|^[A-Z]{2}-|^(Full|Part|Contract|Temp|Intern|Casual|Ongoing|true|false)/i) && !v.match(/^\w{3} \d{1,2}, \d{4}/) && !v.match(/^\d{1,2}-\w{3}-\d{4}/)) {
      department = v;
      continue;
    }
  }

  return { title, location, department, employment_type: schedule };
}

async function fetchJobDetail(company, portal, jobId) {
  try {
    const url = `https://${company}.taleo.net/careersection/${encodeURIComponent(portal)}/jobdetail.ftl?job=${jobId}&lang=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Try JSON-LD first (Starbucks, etc.)
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    let ldData = null;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld['@type'] === 'JobPosting' && ld.title) { ldData = ld; break; }
      } catch {}
    }

    // Parse pipe-delimited data for location/dept/schedule
    const pipeData = parsePipeData(html, jobId);

    if (ldData) {
      // When JSON-LD exists, use it for title/description/posted.
      // For location, scan pipe data for location-like values (contain country-region pattern)
      let location = null;
      if (pipeData) {
        // Check if pipe location looks like a real location (contains hyphen-separated region)
        if (pipeData.location && pipeData.location.match(/^[A-Z]{2}-/)) {
          location = pipeData.location;
        }
      }
      if (!location && ldData.jobLocation?.address) {
        location = [ldData.jobLocation.address.addressLocality, ldData.jobLocation.address.addressRegion, ldData.jobLocation.address.addressCountry].filter(Boolean).join(', ');
      }

      return {
        title: ldData.title,
        description: ldData.description,
        location,
        department: null,
        posted_at: ldData.datePosted || null,
        employment_type: ldData.employmentType || null,
        company: ldData.hiringOrganization?.name || null,
      };
    }

    if (pipeData) {
      // Extract description from !*! delimited URL-encoded HTML sections within pipe data
      let description = null;
      if (html.includes('!*!') && html.includes(PIPE_SEP)) {
        // Scope to the pipe data section only
        const pipeStart = html.indexOf(PIPE_SEP);
        const pipeEnd = html.lastIndexOf(PIPE_SEP) + PIPE_SEP.length + 5000;
        const pipeSection = html.substring(pipeStart, Math.min(html.length, pipeEnd));
        const starParts = pipeSection.split('!*!');
        const descSegments = [];
        for (let i = 1; i < starParts.length; i++) {
          let raw = starParts[i];
          // Trim at next pipe separator if present
          const pipeIdx = raw.indexOf(PIPE_SEP);
          if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx);
          if (raw.length < 30) continue;
          try {
            const decoded = decodeURIComponent(raw);
            if (decoded.length > 50 && /<(p|li|br|ul|ol|div|span|h[1-6]|table|tr|td|strong|em|b|i)\b/i.test(decoded)) {
              descSegments.push(decoded);
            }
          } catch { /* malformed URI sequence — skip */ }
        }
        if (descSegments.length > 0) {
          description = descSegments.join('\n');
        }
      }

      // Fall back to og:description if pipe data yielded nothing
      if (!description) {
        const ogDesc = html.match(/og:description[^>]*content="([^"]*)"/i);
        if (ogDesc?.[1] && !ogDesc[1].includes('Click the link')) {
          description = ogDesc[1];
        }
      }

      return {
        title: pipeData.title,
        description,
        location: pipeData.location,
        department: pipeData.department,
        posted_at: null,
        employment_type: pipeData.employment_type,
        company: null,
      };
    }

    // Last fallback: og:title
    const ogTitle = html.match(/og:title[^>]*content="([^"]*)"/i);
    return {
      title: ogTitle?.[1] || null,
      description: null, location: null, department: null,
      posted_at: null, employment_type: null, company: null,
    };
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const portals = await discoverPortals(clientname);
  if (portals.length === 0) throw new Error(`Taleo: no portals found for ${clientname}`);

  const portal = portals[0];
  const jobIds = await fetchJobsFromSitemap(clientname, portal);
  if (jobIds.length === 0) return { jobs: [], meta: { companyName: null } };

  const jobs = [];
  let companyName = null;

  for (let i = 0; i < jobIds.length; i += DETAIL_BATCH_SIZE) {
    const batch = jobIds.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(id => fetchJobDetail(clientname, portal, id))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let j = 0; j < batch.length; j++) {
      const jobId = batch[j];
      const detail = details[j];
      if (!companyName && detail?.company) companyName = detail.company;

      jobs.push({
        external_id: `taleo_${jobId}`,
        title: detail?.title || `Job ${jobId}`,
        department: detail?.department || null,
        location: detail?.location || null,
        workplace_type: null,
        employment_type: detail?.employment_type || null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: detail?.description || null,
        url: `https://${clientname}.taleo.net/careersection/${encodeURIComponent(portal)}/jobdetail.ftl?job=${jobId}&lang=en`,
        posted_at: detail?.posted_at || null,
        raw_data: { jobId, portal },
      });
    }

    if (i + DETAIL_BATCH_SIZE < jobIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  logger.info({ slug: clientname, portal, fetched: jobs.length }, 'Taleo fetch complete');
  return { jobs, meta: { companyName } };
}

module.exports = { fetchJobs, discoverPortals };
