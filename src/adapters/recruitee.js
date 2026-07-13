/**
 * Recruitee adapter. Public JSON feed: {slug}.recruitee.com/api/offers
 * One call returns all published offers with full descriptions — no per-job fetch.
 */
async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.recruitee.com/api/offers`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Recruitee HTTP ${res.status}`);

  // Dead/closed accounts redirect to a marketing page (HTML). Guard so res.json()
  // doesn't throw an opaque parse error.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Recruitee: "${clientname}" returned non-JSON (${contentType || 'unknown'})`);
  }

  const data = await res.json();
  const jobs = (data.offers || []).map(job => ({
    external_id: `recruitee_${job.id}`,
    title: job.title,
    department: job.department || null,
    location: job.location || [job.city, job.country].filter(Boolean).join(', ') || null,
    workplace_type: job.remote ? 'remote' : null,
    employment_type: job.employment_type_code || null,
    salary_min: job.min_salary || null,
    salary_max: job.max_salary || null,
    salary_currency: job.salary_currency || null,
    salary_interval: null,
    description: job.description || null,
    url: job.careers_url || `https://${encodeURIComponent(clientname)}.recruitee.com/o/${job.slug || job.id}`,
    posted_at: job.published_at || null,
    raw_data: job,
  }));

  return {
    jobs,
    meta: {
      companyName: data.company?.name || null,
      logoUrl: data.company?.logo_url || null,
    },
  };
}

module.exports = { fetchJobs };
