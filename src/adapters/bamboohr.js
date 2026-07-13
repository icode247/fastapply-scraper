const DETAIL_BATCH_SIZE = 5;

async function fetchJobDetail(company, jobId) {
  try {
    const res = await fetch(
      `https://${company}.bamboohr.com/careers/${jobId}/detail`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.result?.jobOpening || null;
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.bamboohr.com/careers/list`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`BambooHR HTTP ${res.status}`);
  const data = await res.json();

  const listings = data.result || [];
  if (listings.length === 0) return { jobs: [], meta: {} };

  // Fetch details in batches for descriptions
  const jobs = [];

  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(j => fetchJobDetail(clientname, j.id))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let k = 0; k < batch.length; k++) {
      const listing = batch[k];
      const detail = details[k];

      // Use detail location (has country/postalCode) with fallback to listing
      const loc = detail?.location || listing.location || {};
      const locationParts = [loc.city, loc.state, loc.addressCountry].filter(Boolean);
      const locationStr = locationParts.join(', ') || null;

      // Determine workplace type from locationType, isRemote flag, or department name
      const locType = detail?.locationType || listing.locationType;
      const isRemote = listing.isRemote
        || locType === '3'
        || (listing.departmentLabel || '').toLowerCase().includes('remote');
      const isHybrid = locType === '2';
      const workplaceType = isRemote ? 'remote' : isHybrid ? 'hybrid' : null;

      // Filter out non-employment-type values like "Active", "Inactive"
      const rawEmpType = detail?.employmentStatusLabel || listing.employmentStatusLabel || '';
      const invalidEmpTypes = ['active', 'inactive', 'open', 'closed'];
      const employmentType = invalidEmpTypes.includes(rawEmpType.toLowerCase())
        ? null : (rawEmpType || null);

      jobs.push({
        external_id: `bamboohr_${listing.id}`,
        title: listing.jobOpeningName,
        department: listing.departmentLabel || null,
        location: locationStr,
        workplace_type: workplaceType,
        employment_type: employmentType,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: detail?.description || null,
        url: detail?.jobOpeningShareUrl || `https://${clientname}.bamboohr.com/careers/${listing.id}`,
        posted_at: detail?.datePosted || null,
        raw_data: listing,
      });
    }
  }

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs };
