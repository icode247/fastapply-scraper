const DETAIL_BATCH_SIZE = 5;

/**
 * Fetch a single job's detail page and extract description + logo.
 */
async function fetchJobDetail(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract description from JSON-LD (find JobPosting, not WebSite)
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

    // Extract company logo from gallery CDN
    let logoUrl = null;
    const logoMatch = html.match(/https:\/\/gallery-cdn\.breezy\.hr\/[^"'\s]+/);
    if (logoMatch) logoUrl = logoMatch[0];

    return { description, logoUrl };
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.breezy.hr/json`,
    { signal: AbortSignal.timeout(10000), redirect: 'manual' }
  );

  // Breezy returns 302 redirect to marketing page for inactive companies
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Breezy: company "${clientname}" no longer exists (redirect)`);
  }
  if (!res.ok) throw new Error(`Breezy HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Breezy: company "${clientname}" returned HTML instead of JSON`);
  }

  const data = await res.json();
  const listings = Array.isArray(data) ? data : [];

  const jobs = [];
  let logoUrl = null;

  // Fetch details in batches
  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(job => {
        const url = job.url || `https://${encodeURIComponent(clientname)}.breezy.hr/p/${job.friendly_id}`;
        return fetchJobDetail(url);
      })
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j];
      const detail = details[j];

      if (!logoUrl && detail?.logoUrl) logoUrl = detail.logoUrl;

      jobs.push({
        external_id: `breezy_${job.id || job.friendly_id}`,
        title: job.name,
        department: job.department || null,
        location: job.location?.name || job.location?.city || null,
        workplace_type: job.location?.is_remote ? 'remote' : null,
        employment_type: job.type?.name || null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: detail?.description || null,
        url: job.url || `https://${encodeURIComponent(clientname)}.breezy.hr/p/${job.friendly_id}`,
        posted_at: job.published_date || null,
        raw_data: job,
      });
    }
  }

  const company = data[0]?.company || {};

  return {
    jobs,
    meta: {
      companyName: company.name || null,
      logoUrl: logoUrl || null,
    },
  };
}

module.exports = { fetchJobs };
