/**
 * LLM-based job classification using HF Inference API.
 * Uses Qwen2.5-72B-Instruct via the HF router for single-call classification.
 * Falls back to regex classifier if HF API fails.
 */
const config = require('../config');
const logger = require('../logger');
const { classifyJob } = require('./classify');

const HF_MODEL = 'Qwen/Qwen2.5-72B-Instruct';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';

const SYSTEM_PROMPT = `You classify job postings. Return ONLY a single valid JSON object. No markdown, no explanation, no extra text.`;

function buildUserPrompt(job) {
  const desc = (job.description || '').substring(0, 1000);
  return `Title: ${job.title || 'Not specified'}
Location: ${job.location || 'Not specified'}
Workplace type: ${job.workplace_type || 'Not specified'}
Description: ${desc}

Classify and return JSON:
{"is_remote":bool,"remote_worldwide":bool,"visa_sponsorship":"yes"|"no"|"unknown","experience_level":"internship"|"entry"|"mid"|"senior"|"lead"|"executive"|"unknown"}

Rules:
- is_remote: true if the job can be performed remotely (not on-site only)
- remote_worldwide: true ONLY if explicitly states worldwide/global/anywhere with NO country or region restriction. "Remote" alone is NOT worldwide. "Anywhere in Latin America" is NOT worldwide.
- visa_sponsorship: "yes" ONLY if description explicitly mentions sponsoring or providing work visas/permits. Generic "authorized to work" is NOT sponsorship.
- experience_level: based on title seniority (I/II = entry/mid, Senior/Staff = senior, Lead/Principal/Director = lead, VP/C-level = executive)`;
}

function parseResponse(content) {
  if (!content) return null;
  // Strip markdown code blocks if present
  const cleaned = content.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Validate fields
    if (typeof parsed.is_remote !== 'boolean') return null;
    if (typeof parsed.remote_worldwide !== 'boolean') return null;
    if (!['yes', 'no', 'unknown'].includes(parsed.visa_sponsorship)) return null;
    if (!['internship', 'entry', 'mid', 'senior', 'lead', 'executive', 'unknown'].includes(parsed.experience_level)) return null;
    return {
      is_remote: parsed.is_remote,
      remote_worldwide: parsed.remote_worldwide,
      visa_sponsorship: parsed.visa_sponsorship === 'unknown' ? null : parsed.visa_sponsorship,
      experience_level: parsed.experience_level === 'unknown' ? null : parsed.experience_level,
    };
  } catch {
    return null;
  }
}

async function classifyWithHF(job) {
  const token = config.HF_API_TOKEN;
  if (!token) return null;

  const res = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: HF_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(job) },
      ],
      max_tokens: 80,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HF API ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return parseResponse(content);
}

/**
 * Classify a job using LLM with regex fallback.
 * @param {Object} job - Job object with title, description, location, workplace_type
 * @returns {Object} Classification result
 */
async function classifyJobWithLLM(job) {
  try {
    const result = await classifyWithHF(job);
    if (result) return result;
  } catch (err) {
    logger.debug({ jobId: job.id, err: err.message }, 'LLM classification failed');
  }
  // No regex fallback — return null fields so job gets retried next cycle
  return { is_remote: null, remote_worldwide: null, visa_sponsorship: null, experience_level: null };
}

module.exports = { classifyJobWithLLM, classifyWithHF, parseResponse };
