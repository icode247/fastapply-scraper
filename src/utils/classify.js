/**
 * Job classification utility.
 * Classifies jobs by:
 *  - is_remote: boolean — fully remote job
 *  - visa_sponsorship: 'yes' | 'no' | null — H1B/visa sponsorship
 *  - experience_level: 'internship' | 'entry' | 'mid' | 'senior' | 'lead' | 'executive' | null
 *
 * Designed to run inline during sync (fast, no I/O).
 */

// ── Remote Detection ──────────────────────────────────────────────

const REMOTE_POSITIVE = [
  /\bfully\s*remote\b/i,
  /\b100%\s*remote\b/i,
  /\bwork\s*from\s*home\b/i,
  /\bremote[\s-]*first\b/i,
  /\bremote\s*position\b/i,
  /\bremote\s*role\b/i,
  /\bremote\s*job\b/i,
  /\bremote\s*opportunity\b/i,
  /\blocation:\s*remote\b/i,
  /\bwork\s*remotely\b/i,
  /\banywhere\b/i,
];

const REMOTE_NEGATIVE = [
  /\bnot\s*remote\b/i,
  /\bnon[\s-]*remote\b/i,
  /\bin[\s-]*office\b/i,
  /\bon[\s-]*site\s*only\b/i,
  /\bhybrid\b/i,
  /\bremote\s*not\s*available\b/i,
  /\bno\s*remote\b/i,
];

function classifyRemote(title, location, workplaceType, description) {
  // Already tagged by adapter
  const wt = (workplaceType || '').toLowerCase();
  if (wt === 'remote' || wt === 'fully remote' || wt === 'fully_remote') return true;
  if (wt === 'hybrid' || wt === 'on-site' || wt === 'onsite' || wt === 'in-office') return false;

  const text = `${title || ''} ${location || ''} ${description || ''}`;

  // Check negatives first
  for (const re of REMOTE_NEGATIVE) {
    if (re.test(text)) return false;
  }

  // Title or location says "Remote", "Worldwide", "Anywhere"
  if (/\bremote\b/i.test(title || '')) return true;
  if (/\bremote\b/i.test(location || '') && !/hybrid/i.test(location || '')) return true;
  if (/\b(?:worldwide|anywhere|global)\b/i.test(location || '')) return true;

  // Description signals
  for (const re of REMOTE_POSITIVE) {
    if (re.test(text)) return true;
  }

  return false;
}

// ── Remote Worldwide Detection ───────────────────────────────────

const WORLDWIDE_POSITIVE = [
  /\banywhere\s*in\s*the\s*world\b/i,
  /\bwork\s*from\s*anywhere\b/i,
  /\blocation\s*agnostic\b/i,
  /\bglobally\s*distributed\b/i,
  /\bfully\s*distributed\b/i,
  /\bremote\s*worldwide\b/i,
  /\bworldwide\s*remote\b/i,
  /\bglobal\s*remote\b/i,
  /\bremote\s*[\-–—]\s*global\b/i,
  /\bno\s*location\s*requirement\b/i,
  /\bopen\s*to\s*(?:all|any)\s*(?:location|countr)/i,
  /\bremote\s*[\-–—]\s*anywhere\b/i,
  // NOT: remote-first — that's a work style, not location
];

const WORLDWIDE_LOCATION = [
  /\bworldwide\b/i,
  /\bglobal\b/i,
  /\bworld\b/i,
  /\banywhere\b/i,
  // NOT: /^remote$/i — "Remote" alone doesn't mean worldwide
];

// Country/region signals in LOCATION field that indicate NOT worldwide
const COUNTRY_SPECIFIC_LOCATION = [
  /\b(?:united\s*states|usa|u\.?s\.?)\b/i,
  /\b(?:united\s*kingdom|uk)\b/i,
  /\b(?:canada|germany|france|india|australia|china|japan|brazil|mexico|spain|italy|netherlands|ireland|singapore|israel|poland|portugal|switzerland|austria|sweden|norway|denmark|finland|belgium|czech|romania|hungary|philippines|indonesia|vietnam|thailand|malaysia|korea|taiwan|argentina|colombia|chile|peru|nigeria|kenya|south\s*africa|egypt|morocco|new\s*zealand)\b/i,
  /\b(?:california|new\s*york|texas|florida|london|berlin|toronto|sydney|paris|amsterdam|dublin|munich|zurich|copenhagen|stockholm|oslo|barcelona|madrid|milan|rome|lisbon|warsaw|prague|budapest|bangalore|mumbai|delhi|shanghai|beijing|tokyo|seoul|manila|jakarta|bogota|sao\s*paulo|nairobi|cape\s*town|auckland)\b/i,
  /\b(?:emea|apac|latam|latin\s*america|americas|north\s*america|south\s*america|asia|africa|middle\s*east|oceania)\b/i,
  /\b(?:europe|european)\b/i,
  /\b(?:US|UK|CA|AU|DE|FR|IN|BR|JP|CN|SG|IE|NL|IL|PL|PT|CH|SE|NO|DK|FI|BE|CZ|RO|NZ)\b/,
];

// Description-level country restrictions (must be explicit restriction, not just mention)
const DESC_COUNTRY_RESTRICTION = [
  /\b(?:us|u\.?s\.?|united\s*states)\s*only\b/i,
  /\b(?:uk|united\s*kingdom)\s*only\b/i,
  /\bmust\s*be\s*(?:based|located)\s*in\b/i,
  /\brestricted\s*to\b/i,
  /\beligible\s*to\s*work\s*in\b/i,
  /\bauthorized\s*to\s*work\s*in\b/i,
  /\bresidents?\s*(?:of|only)\b/i,
  /\bbased\s*(?:in|out\s*of)\s*(?:europe|the\s*us|the\s*uk|the\s*united)/i,
];

function classifyRemoteWorldwide(title, location, description, isRemote) {
  if (!isRemote) return false;

  const loc = (location || '').trim();
  const desc = description || '';
  const titleStr = title || '';

  // Step 0: Check TITLE for country/region signals
  // e.g. "Remote - United States", "Remote US - EST", "Remote - Western Region"
  for (const cs of COUNTRY_SPECIFIC_LOCATION) {
    if (cs.test(titleStr)) return false;
  }

  // Step 1: Check if location is country/region-specific → NOT worldwide
  if (loc.length >= 2) {
    for (const cs of COUNTRY_SPECIFIC_LOCATION) {
      if (cs.test(loc)) return false;
    }
  }

  // Step 1b: "Anywhere in [region]" — regional, not worldwide
  if (/\banywhere\s+in\b/i.test(loc) && !/\banywhere\s+in\s+the\s+world\b/i.test(loc)) return false;

  // Step 1c: Physical/on-site/venue jobs — cannot be worldwide (check BEFORE location match)
  if (/\b(?:on[\-\s]?site|in[\-\s]?office|in[\-\s]?person)\s+(?:required|only|position|role)\b/i.test(desc)) return false;
  if (/\b(?:convention\s*center|warehouse|factory|store|restaurant|clinic|hospital)\b/i.test(titleStr)) return false;
  if (/\b(?:car\s*detail|janitor|custodian|forklift|housekeeper|cashier|bartender|barista|dishwasher|cook\b|chef\b|plumber|electrician|mechanic|driver|delivery|caregiver|nurse\b)/i.test(titleStr)) return false;
  // City name in title suggests location-specific role
  if (/\b(?:dallas|fort\s*worth|new\s*york|chicago|los\s*angeles|san\s*francisco|houston|atlanta|miami|austin|denver|seattle|boston|portland|phoenix|charlotte|nashville|minneapolis|detroit|philadelphia|tampa|orlando|las\s*vegas|pittsburgh|indianapolis|columbus|raleigh|memphis|richmond|salt\s*lake|sacramento|san\s*diego|san\s*antonio|san\s*jose|terre\s*haute|south\s*oc)\b/i.test(titleStr)) return false;

  // Step 2: Location explicitly says worldwide/anywhere/global
  for (const re of WORLDWIDE_LOCATION) {
    if (re.test(loc)) return true;
  }

  // Step 3: No location — check description for EXPLICIT worldwide signals
  // But also check for country restrictions in description
  if (!loc || loc.length < 3) {
    // First check if description has country restrictions
    for (const cs of DESC_COUNTRY_RESTRICTION) {
      if (cs.test(desc)) return false;
    }
    // Check for on-site/hybrid contradictions in description
    if (/\b(?:on[\-\s]?site|in[\-\s]?office|in[\-\s]?person)\s+(?:required|only|position|role|work|days?)\b/i.test(desc)) return false;
    // Then check for positive worldwide signals in description
    for (const re of WORLDWIDE_POSITIVE) {
      if (re.test(desc)) return true;
    }
    // No location + no description signals = UNKNOWN, not worldwide
    return false;
  }

  // Step 4: Has a specific location (not matched as country but still a place name)
  // If location is set and non-trivial, it's a specific place → NOT worldwide
  // Only override if description has STRONG worldwide signals
  if (loc.length > 3) {
    // Location is a specific place (city, office, etc.) — not worldwide
    // unless description EXPLICITLY says "anywhere in the world" etc.
    for (const cs of DESC_COUNTRY_RESTRICTION) {
      if (cs.test(desc)) return false;
    }
    for (const re of WORLDWIDE_POSITIVE) {
      if (re.test(desc)) {
        // Even with worldwide in desc, a specific location wins
        // "QUETZALTENANGO" + "globally distributed" → still Guatemala-specific
        return false;
      }
    }
    return false;
  }

  return false;
}

// ── Visa Sponsorship Detection ────────────────────────────────────

const VISA_NO_PATTERNS = [
  /\bunable\s*to\s*(?:offer\s*|provide\s*)?(?:[\w\s-]*)?sponsor/i,
  /\bcannot\s*(?:offer\s*|provide\s*)?sponsor/i,
  /\bwill\s*not\s*(?:offer\s*|provide\s*|pursue\s*)?(?:have\s*)?(?:[\w\s-]*)?sponsor/i,
  /\bdoes\s*not\s*(?:offer\s*|provide\s*)?sponsor/i,
  /\bdo\s*not\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  // Simple "do not sponsor" without offer/provide (e.g. "we do not sponsor visa")
  /\bdo\s*not\s*sponsor\b/i,
  /\bcannot\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  /\bnot\s*(?:offer|provide|available)\s*(?:[\w\s-]*)?sponsor/i,
  // "not ... able to sponsor" with optional words in between (e.g. "not currently able to sponsor")
  /\bnot\s+(?:\w+\s+)*able\s+to\s+sponsor/i,
  // "not able to offer/provide visa sponsorship" (e.g. "We are not able to offer visa sponsorship")
  /\bnot\s+(?:\w+\s+)*able\s+to\s+(?:offer|provide)\s+(?:[\w\s-]*)?sponsor/i,
  // "not in a position to offer/provide visa sponsorship"
  /\bnot\s+in\s+a\s+position\s+to\s+(?:offer|provide)\s+(?:[\w\s-]*)?sponsor/i,
  /\bno\s*(?:h[\s-]?1b\s*)?(?:visa\s*)?sponsorship\b/i,
  /\bsponsorship\s*(?:is\s*)?(?:not|unavailable)\b/i,
  /\bwithout\s*(?:visa\s*)?sponsorship\b/i,
  /\bnot\s*eligible\s*for\s*(?:visa\s*)?sponsorship\b/i,
  /\bmust\s*(?:be\s*)?(?:legally\s*)?(?:authorized|eligible)\s*to\s*work\b/i,
  /\bauthorized\s*to\s*work\s*in\s*the\s*(?:united\s*states|u\.?s\.?|us)\s*without\b/i,
  /\bno\s*(?:work\s*)?visa\b/i,
  /\bneed\s*not\s*apply\b.*\b(?:h[\s-]?1b|visa)\b/i,
  /\b(?:h[\s-]?1b|visa)\b.*\bneed\s*not\s*apply\b/i,
  /\bnot\s*(?:be\s*)?(?:considered|accepted)\b.*\b(?:visa|sponsor)/i,
  /\brequir(?:e|ing)\s*(?:visa\s*)?sponsorship\s*will\s*not\b/i,
  /\bnot\s*(?:require|need)\s*(?:visa\s*)?sponsorship\b/i,
  /\bdo\s*not\s*apply\b.*\b(?:h[\s-]?1b|visa)\b/i,
  // "will not have sponsorship available" — future tense negation
  /\bwill\s*not\s*have\s*sponsorship\b/i,
  // Immigration/relocation negations
  /\bnot\s*(?:eligible|available)\s*(?:for\s*)?(?:relocation|immigration)/i,
  /\bisn'?t\s*eligible\s*(?:for\s*)?(?:relocation|immigration)/i,
  /\bno\s*(?:relocation|immigration)\s*(?:support|assistance|sponsorship)/i,
  /\b(?:relocation|immigration)\s*(?:support|assistance|sponsorship)\s*(?:is\s*)?(?:not|unavailable)/i,
  /\bnot\s*eligible\s*for\s*relocation\b/i,
  /\bwithout\s*(?:relocation|immigration)\s*(?:support|assistance)/i,
  /\bcannot\s*(?:offer|provide)\s*(?:[\w\s-]*)?(?:immigration|relocation)\s*(?:support|assistance)/i,
  /\bnot\s*(?:offer|provide)\s*(?:[\w\s-]*)?(?:immigration|relocation)\s*(?:support|assistance)/i,
  // "No Relocation and Visa Support" — combined negation
  /\bno\s*relocation\s*(?:and|&)\s*visa\s*(?:support|assistance)\b/i,
  /\bno\s*visa\s*(?:and|&)\s*relocation\s*(?:support|assistance)\b/i,
  // "does not engage in ... sponsorship"
  /\bdoes\s*not\s*engage\s*in\s*(?:[\w\s-]*)?(?:sponsor|immigration)/i,
  // "Visa / Sponsorship Available: Not Available" or "Not Available" after sponsorship
  /\b(?:visa|sponsorship)\s*(?:\/\s*(?:visa|sponsorship)\s*)?available\s*:\s*not\s*available\b/i,
  /\bsponsorship\s*available\s*:\s*(?:no|not|none|unavailable)\b/i,
  // US citizenship required
  /\b(?:us|u\.?s\.?)\s*citizenship\s*(?:is\s*)?required\b/i,
  /\bcitizenship\s*(?:is\s*)?required\b/i,
  // "inability to offer/provide visa sponsorship"
  /\binability\s*to\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  // "not sponsoring visas" / "is not sponsoring"
  /\bnot\s*sponsoring\b/i,
  // Contractions: "don't offer/provide/sponsor", "doesn't offer/sponsor", "won't sponsor", "can't sponsor"
  /\bdon'?t\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  /\bdon'?t\s*sponsor\b/i,
  /\bdoesn'?t\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  /\bdoesn'?t\s*sponsor\b/i,
  /\bwon'?t\s*sponsor\b/i,
  /\bcan'?t\s*sponsor\b/i,
];

const VISA_YES_PATTERNS = [
  /\bvisa\s*sponsor(?:ship)?\s*(?:available|offered|provided|included)\b/i,
  /\bwilling\s*to\s*sponsor\b/i,
  /\bopen\s*to\s*sponsor/i,
  /\bproudly\s*sponsor/i,
  /\bwe\s*(?:do\s*)?sponsor\s*(?:h[\s-]?1b|work\s*visa|visa)\b/i,
  /\bvisa\s*(?:support|assistance)\s*(?:available|offered|provided|included)\b/i,
  /\bimmigration\s*(?:support|assistance|sponsorship)\s*(?:available|offered|provided|included|is\s*available)\b/i,
  /\b(?:offer|provide)s?\s*(?:visa|immigration)\s*(?:support|assistance|sponsorship)\b/i,
  /\bh[\s-]?1b\s*transfer/i,
  /\bh[\s-]?1b\s*(?:visa\s*)?sponsor(?:ship)?\s*(?:available|offered|provided|included|supported)\b/i,
  // Removed: /\bvisa\s*arrangements\b/i — too broad, matches travel visa logistics
  // "Sponsorship Available: Yes" — explicit positive with colon format
  /\bsponsorship\s*available\s*:\s*yes\b/i,
  /\bsponsorship\s*:\s*yes\b/i,
  /\bvisa\s*(?:\/\s*)?sponsorship\s*available\s*:\s*(?:yes|available)\b/i,
  // "visa support" / "work visa support" (without negation — checked above)
  /\b(?:with\s+)?visa\s*support\b/i,
  /\bwork\s*visa\s*support\b/i,
  // "Sponsorship available for ..." (e.g. "for qualified candidates", "for the right candidate")
  /\bsponsorship\s*available\s*for\b/i,
  // "can sponsor" / "will sponsor" — require visa context nearby
  /\bcan\s*sponsor\s*(?:your\s*)?(?:h[\s-]?1b|visa|work\s*(?:permit|authorization))\b/i,
  /\bwill\s*sponsor\s*(?:your\s*)?(?:h[\s-]?1b|visa|work\s*(?:permit|authorization))\b/i,
  // "sponsor your visa" / "sponsor visas" / "sponsoring visa"
  /\bsponsor\s*your\s*visa/i,
  /\bsponsoring\s*(?:h[\s-]?1b|work\s*)?visa/i,
  // "relocation and visa support" / "relocation package with visa"
  /\brelocation\s*(?:package\s*)?(?:with|and|&)\s*visa\b/i,
  // "immigration support" — require qualifier to avoid false positives
  /\bimmigration\s*support\s*(?:available|offered|provided|included)\b/i,
];

function classifyVisa(description) {
  if (!description) return null;

  // Check "no" patterns first (more common, higher confidence)
  for (const re of VISA_NO_PATTERNS) {
    if (re.test(description)) return 'no';
  }

  // Check "yes" patterns
  for (const re of VISA_YES_PATTERNS) {
    if (re.test(description)) return 'yes';
  }

  return null;
}

// ── Experience Level Detection ────────────────────────────────────

const LEVEL_PATTERNS = {
  internship: [
    /\bintern(?:ship)?\b/i,
    /\bco[\s-]?op\b/i,
    /\bsummer\s*(?:student|analyst|associate)\b/i,
    /\bstudent\b/i,
    /\bapprentice/i,
    /\btrainee\b/i,
  ],
  entry: [
    /\bentry[\s-]*level\b/i,
    /\bjunior\b/i,
    /\bjr\.?\b/i,
    /\bnew\s*grad(?:uate)?\b/i,
    /\brecent\s*grad(?:uate)?\b/i,
    /\bfresh\s*grad(?:uate)?\b/i,
    /\bgraduate\s*(?:program|role|position|engineer|analyst|developer)\b/i,
    /\bassociate\s+\w+/i,
    /\b(?:analyst|engineer|developer|designer)\s*[i1]\b/i,
    /\b0[\s-]*(?:to|-)[\s-]*[12]\s*years?\b/i,
    /\bno\s*experience\s*(?:required|needed|necessary)\b/i,
    /\blevel\s*[i1]\b/i,
  ],
  mid: [
    /\bmid[\s-]*(?:level|senior)\b/i,
    /\b(?:analyst|engineer|developer|designer|associate)\s*(?:ii|2|iii|3)\b/i,
    /\b[3-5]\+?\s*years?\b/i,
    /\blevel\s*(?:ii|2|iii|3)\b/i,
  ],
  senior: [
    /\bsenior\b/i,
    /\bsr\.?\b/i,
    /\bstaff\b/i,
    /\bprincipal\b/i,
    /\b(?:analyst|engineer|developer|designer)\s*(?:iv|4|v|5)\b/i,
    /\blead\s*(?:\w+\s+)?(?:engineer|developer|designer|analyst)\b/i,
    /\b(?:7|8|9|10)\+?\s*years?\b/i,
    /\blevel\s*(?:iv|4|v|5)\b/i,
  ],
  lead: [
    /\bteam\s*lead\b/i,
    /\btech\s*lead\b/i,
    /\bengineering\s*(?:lead|manager)\b/i,
    /\bmanager\b/i,
    /\bhead\s*of\b/i,
    /\bgroup\s*lead\b/i,
    /\blead\b/i,
  ],
  executive: [
    /\bdirector\b/i,
    /\bvp\b/i,
    /\bvice\s*president\b/i,
    /\bc[etofi]o\b/i,
    /\bchief\b/i,
    /\bsvp\b/i,
    /\bevp\b/i,
    /\bpartner\b/i,
    /\bfounding\b/i,
  ],
};

// ── IC false-friend families ──────────────────────────────────────
// Titles containing "executive", "manager", or "partner" that are INDIVIDUAL
// CONTRIBUTORS, not C-suite or people-leads. The generic patterns above would
// otherwise mislabel them (the bare /\bexecutive\b/ used to send every
// "Account Executive" — a salesperson — to the executive bucket). These are
// checked first and ranked on an IC ladder by seniority modifier.
const SALES_EXECUTIVE = /\b(?:account|sales|advertising|ad|media|client|commercial|relationship|key\s+account|enterprise|business\s+development|inside\s+sales|field\s+sales)\s+executive\b/i;
const SALES_REP = /\bsdr\b|\bbdr\b|\b(?:sales|business)\s+development\s+(?:representative|rep)\b/i;
const IC_MANAGER = /\b(?:account|product|project|program|portfolio|category|brand|community|content)\s+manager\b|\bpartner(?:ships?)?\s+manager\b|\bproduct\s+owner\b/i;
const BUSINESS_PARTNER = /\b(?:business|people|hr|human\s+resources|talent|finance|tech(?:nology)?)\s+partner\b/i;
const EXEC_ASSISTANT = /\bexecutive\s+(?:assistant|administrator)\b|\b(?:administrative|admin)\s+assistant\b/i;

// Seniority modifiers used to rank an IC title up or down from its base level.
const SENIOR_MOD = /\b(?:senior|sr\.?|staff|principal|lead|enterprise|strategic)\b/i;
const JUNIOR_MOD = /\b(?:junior|jr\.?|entry[\s-]*level|associate|trainee|graduate|apprentice|assistant)\b/i;

function rankByModifier(titleLower, base) {
  if (SENIOR_MOD.test(titleLower)) return 'senior';
  if (JUNIOR_MOD.test(titleLower)) return 'entry';
  return base;
}

// Priority order: most specific first
const LEVEL_PRIORITY = ['internship', 'entry', 'executive', 'senior', 'lead', 'mid'];

function classifyExperienceLevel(title, description) {
  const t = title || '';
  const titleLower = t.toLowerCase();

  // Internship wins over everything (e.g. "Sales Intern", "Marketing Intern").
  for (const re of LEVEL_PATTERNS.internship) {
    if (re.test(t)) return 'internship';
  }

  // IC false-friend families — resolve BEFORE the generic exec/lead patterns so
  // "Account Executive" (sales IC), "Product Manager" (IC), "HR Business Partner"
  // and "Executive Assistant" don't get mislabeled as executive/lead.
  if (EXEC_ASSISTANT.test(titleLower)) return 'entry';
  if (SALES_REP.test(titleLower)) return rankByModifier(titleLower, 'entry');
  if (SALES_EXECUTIVE.test(titleLower) || IC_MANAGER.test(titleLower) || BUSINESS_PARTNER.test(titleLower)) {
    return rankByModifier(titleLower, 'mid');
  }

  // Title-based classification (highest confidence). Internship handled above.
  for (const level of LEVEL_PRIORITY) {
    if (level === 'internship') continue;
    for (const re of LEVEL_PATTERNS[level]) {
      if (re.test(t)) {
        // Disambiguate: "Senior Manager" → senior, not lead
        if (level === 'lead' && /\bsenior\b/i.test(titleLower)) return 'senior';
        return level;
      }
    }
  }

  // Description-based (lower confidence, only for entry/internship)
  if (description) {
    for (const re of LEVEL_PATTERNS.internship) {
      if (re.test(description)) return 'internship';
    }
    for (const re of LEVEL_PATTERNS.entry) {
      if (re.test(description)) return 'entry';
    }
  }

  return null;
}

// ── Main classify function ────────────────────────────────────────

function classifyJob(job) {
  const title = job.title || '';
  const description = job.description || '';
  const location = job.location || '';
  const workplaceType = job.workplace_type || '';

  const is_remote = classifyRemote(title, location, workplaceType, description);

  return {
    is_remote,
    remote_worldwide: classifyRemoteWorldwide(title, location, description, is_remote),
    visa_sponsorship: classifyVisa(description),
    experience_level: classifyExperienceLevel(title, description),
  };
}

module.exports = { classifyJob, classifyRemote, classifyVisa, classifyExperienceLevel, classifyRemoteWorldwide };
