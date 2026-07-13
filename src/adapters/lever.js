/**
 * Build full description from Lever's split fields:
 * - descriptionPlain/description: intro/overview
 * - lists[]: sections like Responsibilities, Requirements, etc.
 * - additionalPlain/additional: extra info (compensation, benefits, etc.)
 */
function buildFullDescription(job) {
  const parts = [];

  // Main description
  if (job.descriptionPlain) parts.push(job.descriptionPlain);
  else if (job.description) parts.push(job.description);

  // Lists (Responsibilities, Requirements, Qualifications, etc.)
  for (const list of (job.lists || [])) {
    if (list.text && list.content) {
      parts.push(`${list.text}:\n${list.content}`);
    }
  }

  // Additional info (compensation, EEO, benefits)
  if (job.additionalPlain) parts.push(job.additionalPlain);
  else if (job.additional) parts.push(job.additional);

  return parts.length > 0 ? parts.join('\n\n') : null;
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(clientname)}`);
  if (!res.ok) throw new Error(`Lever HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (Array.isArray(data) ? data : []).map(job => {
    const salary = job.salaryRange || {};
    return {
      external_id: `lever_${job.id}`,
      title: job.text,
      department: job.categories?.team || job.categories?.department || null,
      location: job.categories?.location || 'Remote',
      workplace_type: job.workplaceType || null,
      employment_type: job.categories?.commitment || null,
      salary_min: salary.min || null,
      salary_max: salary.max || null,
      salary_currency: salary.currency || null,
      salary_interval: salary.interval || null,
      description: buildFullDescription(job),
      url: job.hostedUrl,
      posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      raw_data: job,
    };
  });

  return { jobs, meta: {} };
}

async function fetchCompanyMeta(clientname) {
  // Lever logos are on the hosted page HTML as S3 URLs
  try {
    const res = await fetch(`https://jobs.lever.co/${encodeURIComponent(clientname)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const html = await res.text();
      // Pattern: lever-client-logos.s3.amazonaws.com/... or lever-client-logos.s3.us-west-2.amazonaws.com/...
      const match = html.match(/https:\/\/lever-client-logos\.s3[^"'\s]+/);
      if (match) return { companyName: null, logoUrl: match[0] };
    }
  } catch {}

  return null;
}

module.exports = { fetchJobs, fetchCompanyMeta };
