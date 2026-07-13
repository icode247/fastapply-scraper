async function fetchJobDetail(companySlug, postingId) {
  try {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companySlug)}/postings/${postingId}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractDescription(jobAd) {
  if (!jobAd?.sections) return null;
  const parts = [];
  for (const section of Object.values(jobAd.sections)) {
    if (section.text) parts.push(section.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function extractSalary(description) {
  if (!description) return {};
  const match = description.match(
    /\$([\d,]+(?:\.\d{2})?)\s*[-–]\s*\$([\d,]+(?:\.\d{2})?)/
  );
  if (match) {
    const min = parseInt(match[1].replace(/,/g, ''), 10);
    const max = parseInt(match[2].replace(/,/g, ''), 10);
    if (min >= 10000 && max >= 10000 && max < 10000000) {
      return { salary_min: String(min), salary_max: String(max), salary_currency: 'USD' };
    }
  }
  return {};
}

async function fetchJobs(clientname) {
  const allJobs = [];
  let offset = 0;
  const limit = 100;

  // Paginate through listings
  while (true) {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(clientname)}/postings?offset=${offset}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`SmartRecruiters HTTP ${res.status}`);
    const data = await res.json();
    const listings = data.content || [];
    if (listings.length === 0) break;

    // Fetch details in batches of 5 for descriptions
    for (let i = 0; i < listings.length; i += 5) {
      const batch = listings.slice(i, i + 5);
      const settled = await Promise.allSettled(
        batch.map(job => fetchJobDetail(clientname, job.id))
      );
      const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

      for (let j = 0; j < batch.length; j++) {
        const job = batch[j];
        const detail = details[j];

        const desc = extractDescription(detail?.jobAd) || null;
        const salary = extractSalary(desc);

        allJobs.push({
          external_id: `smartrecruiters_${job.id}`,
          title: job.name,
          department: job.department?.label || null,
          location: job.location?.fullLocation || job.location?.city || 'Remote',
          workplace_type: job.location?.remote ? 'remote' : (job.location?.hybrid ? 'hybrid' : null),
          employment_type: job.typeOfEmployment?.label || null,
          salary_min: salary.salary_min || null,
          salary_max: salary.salary_max || null,
          salary_currency: salary.salary_currency || null,
          salary_interval: null,
          description: desc,
          url: detail?.postingUrl || `https://jobs.smartrecruiters.com/${encodeURIComponent(clientname)}/${job.id}`,
          posted_at: job.releasedDate || null,
          raw_data: job,
        });
      }
    }

    offset += listings.length;
    if (listings.length < limit) break;
  }

  return {
    jobs: allJobs,
    meta: {
      companyName: allJobs[0]?.raw_data?.company?.name || null,
      logoUrl: null,
    },
  };
}

module.exports = { fetchJobs };
