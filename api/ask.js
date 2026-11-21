// api/ask.js - Vercel Serverless Function powered by Groq with model fallback & rate limiting

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1-minute window
const MAX_REQUESTS_PER_WINDOW = 20;    // Max 20 requests per IP per minute
const rateLimitStore = new Map();

// Standard chat models in Groq's catalog (ordered by fast/reliable availability)
const GROQ_MODEL_CANDIDATES = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b'
];

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1, retryAfterSec: 0 };
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  entry.count += 1;
  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_WINDOW - entry.count,
    retryAfterSec: 0
  };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown-client';
}

async function callGroqModel(model, systemMessage, userPrompt, apiKey) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 1024
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Groq API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return data?.choices?.[0]?.message?.content?.trim() || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // 1. IP Rate Limiting
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);

  res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS_PER_WINDOW));
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));

  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSec));
    return res.status(429).json({
      error: `Rate limit exceeded. Please wait ${rateLimit.retryAfterSec}s before retrying.`
    });
  }

  // 2. Groq API Key Check
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GROQ_API_KEY is not configured in Vercel environment variables.'
    });
  }

  // 3. Request Body Validation
  const { question, shiftContext } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question parameter is missing or empty.' });
  }

  const systemMessage = `You are an operational audit assistant for Birta Green Palace analyzing KOT (Kitchen Order Ticket) and F&B reports.
Answer the user's inquiry accurately and concisely using ONLY the provided shift data.
Do not invent or assume tokens, timestamps, rates, or items. Always specify exact KOT token numbers, table, and timestamps when referencing orders.
If an item was cancelled/voided or never ordered, state that clearly.`;

  const userPrompt = `=== SHIFT AUDIT CONTEXT ===
${JSON.stringify(shiftContext || {}, null, 2)}

=== USER QUESTION ===
${question.trim()}`;

  let lastError = null;
  for (const model of GROQ_MODEL_CANDIDATES) {
    try {
      const answer = await callGroqModel(model, systemMessage, userPrompt, apiKey);
      if (answer) {
        return res.status(200).json({ answer, model });
      }
    } catch (err) {
      lastError = err;
    }
  }

  return res.status(lastError?.status || 502).json({
    error: lastError?.message || 'Unable to get a response from available Groq models.'
  });
}
