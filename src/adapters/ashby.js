async function fetchJobs(clientname) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(clientname)}?includeCompensation=true`);
  if (!res.ok) throw new Error(`Ashby HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => {
    const comp = job.compensation;
    return {
      external_id: `ashby_${job.id}`,
      title: job.title,
      department: job.department || job.team || null,
      location: job.location || 'Remote',
      workplace_type: job.workplaceType || null,
      employment_type: job.employmentType || null,
      salary_min: comp?.compensationTierSummary?.[0]?.min || null,
      salary_max: comp?.compensationTierSummary?.[0]?.max || null,
      salary_currency: comp?.compensationTierSummary?.[0]?.currency || null,
      salary_interval: comp?.compensationTierSummary?.[0]?.interval || null,
      description: job.descriptionHtml || job.descriptionPlain || null,
      url: job.jobUrl,
      posted_at: job.publishedAt || null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: data.organizationName || null,
      logoUrl: data.organizationLogo || null,
    },
  };
}

async function fetchCompanyMeta(clientname) {
  // First try the posting API which may have the logo
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(clientname)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.organizationLogo) return { companyName: data.organizationName, logoUrl: data.organizationLogo };
    }
  } catch {}

  // Fallback: scrape the hosted page for org-theme-logo or org-theme-social images
  try {
    const res = await fetch(`https://jobs.ashbyhq.com/${encodeURIComponent(clientname)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const html = await res.text();
      // Prefer org-theme-logo over org-theme-social
      const logoMatch = html.match(/https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-logo\/[^"'\s]+/);
      if (logoMatch) return { companyName: null, logoUrl: logoMatch[0] };

      const socialMatch = html.match(/https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-social\/[^"'\s]+/);
      if (socialMatch) return { companyName: null, logoUrl: socialMatch[0] };
    }
  } catch {}

  return null;
}

module.exports = { fetchJobs, fetchCompanyMeta };
