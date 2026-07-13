async function fetchJobDetail(boardSlug, jobUuid) {
  try {
    const res = await fetch(
      `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(boardSlug)}/jobs/${jobUuid}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractDescription(desc) {
  if (!desc) return null;
  const parts = [];
  if (desc.company) parts.push(desc.company);
  if (desc.role) parts.push(desc.role);
  if (desc.compensation) parts.push(desc.compensation);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(clientname)}/jobs`);
  if (!res.ok) throw new Error(`Rippling HTTP ${res.status}`);
  const data = await res.json();
  const listings = Object.values(data);

  const jobs = [];

  // Fetch details in batches of 5
  for (let i = 0; i < listings.length; i += 5) {
    const batch = listings.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(job => fetchJobDetail(clientname, job.uuid))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j];
      const detail = details[j];

      jobs.push({
        external_id: `rippling_${job.uuid}`,
        title: job.name,
        department: job.department?.label || null,
        location: job.workLocation?.label || 'Remote',
        workplace_type: job.workLocation?.label?.toLowerCase().startsWith('remote') ? 'remote' : null,
        employment_type: null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: extractDescription(detail?.description) || null,
        url: job.url || `https://ats.rippling.com/${encodeURIComponent(clientname)}/jobs/${job.uuid}`,
        posted_at: null,
        raw_data: job,
      });
    }
  }

  return { jobs, meta: {} };
}

module.exports = { fetchJobs };
