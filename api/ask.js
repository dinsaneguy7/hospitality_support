// api/ask.js - Vercel Serverless Function with Rate Limiting & Gemini Integration

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1-minute window
const MAX_REQUESTS_PER_WINDOW = 15;    // Max 15 requests per IP per minute
const rateLimitStore = new Map();

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

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // 1. Rate Limiting Check
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);

  res.setHeader('X-RateLimit-Limit', String(MAX_REQUESTS_PER_WINDOW));
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));

  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSec));
    return res.status(429).json({
      error: `Rate limit exceeded. Please wait ${rateLimit.retryAfterSec}s before sending another request.`
    });
  }

  // 2. Secret Key Retrieval
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in Vercel environment variables.'
    });
  }

  // 3. Request Body Validation
  const { question, shiftContext } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question parameter is missing or empty.' });
  }

  // 4. Construct Prompt
  const prompt = `You are an operational audit assistant for Birta Green Palace analyzing KOT (Kitchen Order Ticket) and F&B reports.
Answer the user's inquiry accurately and concisely using ONLY the provided shift data below.
Do not invent or assume tokens, timestamps, rates, or items. Always specify exact KOT token numbers, table, and timestamps when referencing orders.
If an item was cancelled/voided or never ordered, state that clearly.

=== SHIFT AUDIT CONTEXT ===
${JSON.stringify(shiftContext || {}, null, 2)}

=== USER QUESTION ===
${question.trim()}
`;

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini API call failed.'
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .filter(Boolean)
        .join('\n') || 'No response returned by the model.';

    return res.status(200).json({ answer });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to communicate with AI endpoint: ' + (err.message || String(err))
    });
  }
}