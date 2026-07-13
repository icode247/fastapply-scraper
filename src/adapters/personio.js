async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.jobs.personio.de/xml`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Personio HTTP ${res.status}`);
  const xml = await res.text();

  const jobs = [];
  const positionRegex = /<position>([\s\S]*?)<\/position>/g;
  let match;

  while ((match = positionRegex.exec(xml)) !== null) {
    const pos = match[1];
    const get = (tag) => {
      const m = pos.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };

    // Extract all CDATA job description sections and concatenate
    const descParts = [];
    const descRegex = /<jobDescription>[\s\S]*?<name>([^<]*)<\/name>[\s\S]*?<value>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/value>[\s\S]*?<\/jobDescription>/g;
    let descMatch;
    while ((descMatch = descRegex.exec(pos)) !== null) {
      const sectionName = descMatch[1].trim();
      const sectionHtml = descMatch[2].trim();
      if (sectionHtml) {
        descParts.push(`<h3>${sectionName}</h3>${sectionHtml}`);
      }
    }

    const id = get('id');
    const name = get('name');
    const department = get('department');
    const office = get('office');
    const schedule = get('schedule');
    const employmentType = get('employmentType');
    const createdAt = get('createdAt');
    const subcompany = get('subcompany');
    const seniority = get('seniority');

    jobs.push({
      external_id: `personio_${id}`,
      title: name,
      department,
      location: office || 'Remote',
      workplace_type: null,
      employment_type: schedule || employmentType || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: descParts.length > 0 ? descParts.join('\n') : null,
      url: `https://${encodeURIComponent(clientname)}.jobs.personio.de/job/${id}?language=en`,
      posted_at: createdAt || null,
      raw_data: { id, name, department, office, schedule, employmentType, seniority, subcompany },
    });
  }

  return {
    jobs,
    meta: {
      companyName: jobs.length > 0 ? jobs[0].raw_data.subcompany : null,
    },
  };
}

module.exports = { fetchJobs };
