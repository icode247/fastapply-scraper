const DETAIL_BATCH_SIZE = 5;

/**
 * Fetch job detail page and extract description, logo from HTML.
 */
async function fetchJobDetail(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract description from JSON-LD (find the JobPosting one, not Organization)
    let description = null;
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld['@type'] === 'JobPosting' && ld.description) {
          description = ld.description;
          break;
        }
      } catch { /* invalid JSON-LD */ }
    }

    // Extract company logo from S3 resumator bucket
    let logoUrl = null;
    const logoMatch = html.match(/src="([^"]*s3\.amazonaws\.com\/resumator[^"]*logo[^"]*)"/i);
    if (logoMatch) {
      logoUrl = logoMatch[1];
      if (logoUrl.startsWith('//')) logoUrl = 'https:' + logoUrl;
    }

    // Extract job attributes from detail page
    const attr = (title) => {
      const m = html.match(new RegExp(`title="${title}"[^>]*>\\s*<i[^>]*><\\/i>([^<]+)`, 'i'));
      return m ? m[1].trim() : null;
    };

    const location = attr('Location');
    const employmentType = attr('Type');
    const department = attr('Department');
    const experience = attr('Experience');

    return { description, logoUrl, location, employmentType, department, experience };
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://app.jazz.co/widgets/basic/create/${encodeURIComponent(clientname)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`JazzHR HTTP ${res.status}`);
  const html = await res.text();

  // Extract logo from widget page
  let logoUrl = null;
  const logoMatch = html.match(/src="([^"]*resumator[^"]*logo[^"]*)"/i);
  if (logoMatch) {
    logoUrl = logoMatch[1];
    if (logoUrl.startsWith('//')) logoUrl = 'https:' + logoUrl;
  }

  // Structure:
  // <div class="resumator-job-title ...">Title</div>
  // <div class="resumator-job-info ...">
  //   <span class="resumator-job-location ...">Location: </span>City, State
  //   <span class="resumator-job-department ...">Department: </span>Dept Name
  // </div>
  // <div ...><a href="https://{slug}.applytojob.com/apply/{jobId}/{title}...">...</a></div>
  const blockRegex = /class="resumator-job-title[^"]*"[^>]*>([^<]+)<\/div>\s*<div[^>]*class="resumator-job-info[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>[\s\S]*?href="(https:\/\/[^"]*\.applytojob\.com\/apply\/([^/]+)\/[^"]*)"[^>]*>/gi;

  const listings = [];
  const seen = new Set();
  let match;

  while ((match = blockRegex.exec(html)) !== null) {
    const [, title, infoBlock, url, jobId] = match;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    // Extract location from info block
    let location = null;
    const locMatch = infoBlock.match(/Location:\s*<\/span>([^<]*)/i);
    if (locMatch && locMatch[1].trim()) location = locMatch[1].trim();

    // Extract department from info block
    let department = null;
    const deptMatch = infoBlock.match(/Department:\s*<\/span>([^<]*)/i);
    if (deptMatch && deptMatch[1].trim()) department = deptMatch[1].trim();

    listings.push({ jobId, title: title.trim(), location, department, url });
  }

  // Fallback: simple link regex
  if (listings.length === 0) {
    const linkRegex = /href="(https:\/\/[^"]*\.applytojob\.com\/apply\/([^/]+)\/([^"?]+)[^"]*)"/g;
    while ((match = linkRegex.exec(html)) !== null) {
      const [, url, jobId, titleSlug] = match;
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      listings.push({
        jobId,
        title: decodeURIComponent(titleSlug).replace(/-/g, ' '),
        location: null,
        department: null,
        url,
      });
    }
  }

  // Fetch details in batches for descriptions and logo
  const jobs = [];
  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(l => fetchJobDetail(l.url))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let j = 0; j < batch.length; j++) {
      const l = batch[j];
      const detail = details[j];

      if (!logoUrl && detail?.logoUrl) logoUrl = detail.logoUrl;

      const location = detail?.location || l.location;
      const department = detail?.department || l.department;

      jobs.push({
        external_id: `jazzhr_${l.jobId}`,
        title: l.title,
        department,
        location,
        workplace_type: location?.toLowerCase().includes('remote') ? 'remote' : null,
        employment_type: detail?.employmentType || null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: detail?.description || null,
        url: l.url,
        posted_at: null,
        raw_data: { jobId: l.jobId, title: l.title, location: l.location, department: l.department },
      });
    }
  }

  return {
    jobs,
    meta: {
      companyName: null,
      logoUrl,
    },
  };
}

module.exports = { fetchJobs };
