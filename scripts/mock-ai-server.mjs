#!/usr/bin/env node
// A tiny OpenAI-compatible chat endpoint, for testing X-Ray's AI layer without
// a provider, a key or a network.
//
//   node scripts/mock-ai-server.mjs            # http://localhost:8787
//   PORT=9000 node scripts/mock-ai-server.mjs
//
// Then in X-Ray: Settings → + OpenAI-compatible, endpoint
// http://localhost:8787, model "mock", and ask something. It answers with a
// summary of the context it actually received, so you can see exactly what the
// retrieval layer sent. Two modes are supported because X-Ray uses both:
//   • stream: false → one JSON body, read for connectivity tests
//   • stream: true  → text/event-stream, the same shape OpenAI sends
//
// It also answers OPTIONS with permissive CORS headers, which is the part most
// local servers get wrong when a browser calls them directly.

import { createServer } from 'node:http';

// An empty or non-numeric PORT (some shells export one) must fall back to the
// default rather than quietly binding a random port.
const requested = Number(process.env.PORT);
const port = Number.isInteger(requested) && requested > 0 ? requested : 8787;
const ORIGIN = '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body, extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders,
    ...extra,
  });
  res.end(payload);
}

/** Words from X-Ray's own prompt scaffolding, not from the codebase. */
const META_WORDS = new Set([
  'File', 'Files', 'Question', 'Context', 'Note', 'Notes', 'Components', 'Component',
  'Rules', 'Excerpts', 'Project', 'Projects', 'Architectural', 'X-Ray',
]);

/**
 * A plausible answer derived from what X-Ray actually sent, so the reply proves
 * the context arrived and gives the "Referenced components" UI something real
 * to highlight.
 */
function answerFor(messages) {
  const user = [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
  const files = [...user.matchAll(/^### File: (.+?) \(lines ([^)]+)\)/gm)].map((match) => ({
    path: match[1],
    lines: match[2],
  }));
  const question = user.split('### Question').pop()?.trim() ?? '';
  const identifiers = [...new Set(user.match(/\b[A-Z][A-Za-z0-9_]{3,}\b/g) ?? [])]
    .filter((word) => !META_WORDS.has(word))
    .slice(0, 4);

  const lines = [
    `**Mock answer.** Asked: “${question}”`,
    '',
    `Context received: ${files.length} file excerpt${files.length === 1 ? '' : 's'}, ${user.length.toLocaleString()} characters.`,
    '',
  ];
  if (files.length > 0) {
    lines.push('Excerpts read:');
    for (const file of files.slice(0, 6)) lines.push(`- \`${file.path}\` (lines ${file.lines})`);
    if (files.length > 6) lines.push(`- …and ${files.length - 6} more`);
  } else {
    lines.push('No file excerpts arrived — only the structural summary.');
  }
  if (identifiers.length > 0) {
    lines.push('', `Components visible in the excerpts: ${identifiers.map((id) => `\`${id}\``).join(', ')}.`);
  }
  lines.push('', '_This reply came from scripts/mock-ai-server.mjs. No real model was called._');
  return lines.join('\n');
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    send(res, 200, { ok: true, mock: true, hint: 'POST /v1/chat/completions' });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: { message: `${req.method} is not supported. POST a chat completion.` } });
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 4_000_000) req.destroy();
  });
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions') && !req.url?.includes('/completions')) {
      send(res, 404, {
        error: {
          message: `No route for ${req.url}. This mock answers POST /v1/chat/completions — a base URL without the path is the usual reason a browser reports an unreachable endpoint.`,
        },
      });
      return;
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      send(res, 400, { error: { message: 'Body was not valid JSON.' } });
      return;
    }

    const answer = answerFor(Array.isArray(body.messages) ? body.messages : []);
    const model = body.model ?? 'mock';
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(answer.length / 4) };

    if (!body.stream) {
      send(res, 200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage,
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders,
    });
    // Chunked like a real stream, so the incremental rendering path is exercised.
    const chunks = answer.match(/[\s\S]{1,40}/g) ?? [];
    let index = 0;
    const timer = setInterval(() => {
      if (index >= chunks.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const event = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ delta: { content: chunks[index++] } }] };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }, 12);
    // Clear on the *response* closing. The request emits 'close' as soon as its
    // body has been read, which is immediately, and that used to kill the
    // stream before a single chunk was sent.
    res.on('close', () => clearInterval(timer));
  });
});

server.listen(port, () => {
  console.log(`Mock OpenAI-compatible endpoint listening on http://localhost:${port}`);
  console.log('X-Ray → Settings → + OpenAI-compatible → endpoint http://localhost:' + port + ', model "mock".');
});
