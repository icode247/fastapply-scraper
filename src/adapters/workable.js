const logger = require('../logger');

async function fetchJobs(clientname) {
  // v3 API: single POST, returns all jobs — no detail calls during sync
  // Descriptions come from the backfill task to avoid rate limiting
  const listRes = await fetch(
    `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(clientname)}/jobs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    }
  );
  if (listRes.status === 429) {
    throw new Error('Workable rate limited (429) — will retry next cycle');
  }
  if (!listRes.ok) throw new Error(`Workable HTTP ${listRes.status}`);
  const listData = await listRes.json();
  const listings = listData.results || [];

  const jobs = listings.map(listing => {
    const loc = listing.location || {};
    return {
      external_id: `workable_${listing.shortcode}`,
      title: listing.title,
      department: listing.department?.[0] || null,
      location: [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'Remote',
      workplace_type: listing.remote ? 'Remote' : (listing.workplace || null),
      employment_type: listing.type === 'full' ? 'Full-time' : listing.type === 'part' ? 'Part-time' : listing.type || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: null,
      url: `https://apply.workable.com/${encodeURIComponent(clientname)}/j/${listing.shortcode}/`,
      posted_at: listing.published || null,
      raw_data: listing,
    };
  });

  // Logo from v1 widget
  let companyName = null;
  let logoUrl = null;
  try {
    const widgetRes = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (widgetRes.ok) {
      const widget = await widgetRes.json();
      companyName = widget.name || null;
      logoUrl = widget.logo || null;
    }
  } catch {}

  return { jobs, meta: { companyName, logoUrl } };
}

async function fetchCompanyMeta(clientname) {
  // Try widget API first — returns S3 logo URL
  try {
    const res = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.logo) return { companyName: data.name || null, logoUrl: data.logo };
    }
  } catch {}

  // Fallback: scrape the careers page for workablehr S3 logo
  try {
    const res = await fetch(`https://apply.workable.com/${encodeURIComponent(clientname)}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/https:\/\/workablehr\.s3[^"'\s]*logo[^"'\s]*/);
      if (match) return { companyName: null, logoUrl: match[0] };
    }
  } catch {}

  return null;
}

module.exports = { fetchJobs, fetchCompanyMeta };
