// api/ask.js - Vercel Serverless Function strictly scoped to uploaded KOT & F&B reports

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1-minute window
const MAX_REQUESTS_PER_WINDOW = 20;    // Max 20 requests per IP per minute
const rateLimitStore = new Map();

const GROQ_MODEL_CANDIDATES = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b'
];

const OUT_OF_SCOPE_REPLY =
  'I can only answer questions about the uploaded KOT and F&B reports (items, quantities, rates, revenue/valuation, tokens, timestamps, tables, servers, cancellations, and discrepancies).';

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

function hasShiftData(shiftContext) {
  if (!shiftContext || typeof shiftContext !== 'object') return false;
  const items = Array.isArray(shiftContext.items) ? shiftContext.items : [];
  return items.length > 0;
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
      temperature: 0,
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

  // 3. Request & Shift Context Validation
  const { question, shiftContext } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question parameter is missing or empty.' });
  }

  if (!hasShiftData(shiftContext)) {
    return res.status(200).json({ answer: OUT_OF_SCOPE_REPLY });
  }

  const systemMessage = `You are a closed-domain audit assistant for KOT (Kitchen Order Ticket) and F&B (Food & Beverage) reports only.
STRICT RULES:
1. Answer ONLY questions about the provided KOT and F&B report data (items, categories, quantities, rates, KOT valuations, F&B revenues, KOT token numbers, order timestamps, tables, servers/waiters, completed vs. cancelled/voided status, and cross-check discrepancies between KOT and F&B).
2. If the user's message is a greeting, general chat, creative writing, coding, trivia, or anything not about the uploaded KOT and F&B reports, do NOT answer it—respond with this exact sentence:
"${OUT_OF_SCOPE_REPLY}"
3. Use ONLY facts present in the provided shift data. Never guess or invent token numbers, timestamps, items, or amounts. If an item or detail is not in the provided data, state that it does not appear in the uploaded reports.`;

  const userPrompt = `=== UPLOADED KOT & F&B SHIFT DATA ===
${JSON.stringify(shiftContext, null, 2)}

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
