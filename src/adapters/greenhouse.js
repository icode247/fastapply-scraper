async function fetchJobs(clientname) {
  const res = await fetch(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(clientname)}/jobs?content=true`);
  if (!res.ok) throw new Error(`Greenhouse HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => ({
    external_id: `greenhouse_${job.id}`,
    title: job.title,
    department: job.departments?.[0]?.name || null,
    location: job.location?.name || 'Remote',
    workplace_type: null,
    employment_type: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: job.content || null,
    url: job.absolute_url,
    posted_at: job.updated_at || null,
    raw_data: job,
  }));

  return { jobs, meta: {} };
}

async function fetchCompanyMeta(clientname) {
  // Try the board page SSR data which has the logo in __remixContext
  try {
    const pageRes = await fetch(`https://job-boards.greenhouse.io/${encodeURIComponent(clientname)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      // Extract logo from __remixContext boardConfiguration
      const remixMatch = html.match(/"logo"\s*:\s*\{\s*"href"\s*:\s*"([^"]+)"/);
      if (remixMatch) return { companyName: null, logoUrl: remixMatch[1] };

      // Fallback: look for S3 CDN logo pattern
      const cdnMatch = html.match(/https:\/\/s\d+-recruiting\.cdn\.greenhouse\.io\/external_greenhouse_job_boards\/logos\/[^"'\s]+/);
      if (cdnMatch) return { companyName: null, logoUrl: cdnMatch[0] };

      // Fallback: recruiting.cdn pattern without s{N} prefix
      const cdnMatch2 = html.match(/https:\/\/recruiting\.cdn\.greenhouse\.io\/external_greenhouse_job_boards\/logos\/[^"'\s]+/);
      if (cdnMatch2) return { companyName: null, logoUrl: cdnMatch2[0] };
    }
  } catch { /* fall through to API */ }

  // Fallback to boards API
  try {
    const res = await fetch(`https://api.greenhouse.io/v1/boards/${encodeURIComponent(clientname)}`);
    if (res.ok) {
      const data = await res.json();
      return { companyName: data.name || null, logoUrl: data.logo || null };
    }
  } catch {}

  return null;
}

module.exports = { fetchJobs, fetchCompanyMeta };
