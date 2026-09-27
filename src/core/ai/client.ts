// Direct browser -> user's configured endpoint calls.
//
// There is no X-Ray backend: requests go straight from this page to the
// endpoint the developer configured. API keys are only ever placed in the
// Authorization / x-api-key header for that one request — never logged, never
// persisted inside an analysed project, never included in the AI context.

import type { AiProviderConfig, ProviderKind } from '../settings/aiSettings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string;
}

export interface SendChatOptions {
  provider: AiProviderConfig;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
}

export class AiError extends Error {
  constructor(message: string, readonly detail?: string, readonly status?: number) {
    super(message);
    this.name = 'AiError';
  }
}

// --- endpoint resolution ---------------------------------------------------

/**
 * Where each provider's chat call lives, relative to a base URL.
 *
 * Provider documentation shows the *base* URL ("https://api.openai.com/v1",
 * "http://localhost:11434"), and pasting exactly that into a chat client is the
 * normal thing to do. Posting to the base is not a network problem — it returns
 * 404 without CORS headers, which the browser reports as an unreachable
 * endpoint. So the base is completed to the real path here, once.
 */
const CHAT_ROUTE: Record<ProviderKind, { version: string; path: string }> = {
  openai: { version: '/v1', path: '/chat/completions' },
  'openai-compatible': { version: '/v1', path: '/chat/completions' },
  anthropic: { version: '/v1', path: '/messages' },
};

/** URLs that already are the full endpoint, whatever is in front of them. */
const COMPLETE_ROUTE = /(\/chat\/completions|\/completions|\/messages|\/api\/chat|\/api\/generate)$/i;
const VERSIONED = /\/v\d+$/i;

export function resolveEndpoint(provider: AiProviderConfig): string {
  return resolveEndpointUrl(provider.kind, provider.endpoint);
}

export function resolveEndpointUrl(kind: ProviderKind, raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `${schemeFor(value)}://${value}`;

  const query = value.indexOf('?');
  const base = (query === -1 ? value : value.slice(0, query)).replace(/\/+$/, '');
  const search = query === -1 ? '' : value.slice(query);

  if (COMPLETE_ROUTE.test(base)) return `${base}${search}`;
  const route = CHAT_ROUTE[kind];
  const path = VERSIONED.test(base) ? route.path : `${route.version}${route.path}`;
  return `${base}${path}${search}`;
}

/**
 * A browser address bar needs a scheme and API docs usually omit one. Local
 * hosts are the ones people type by hand, and they are the ones served over
 * plain http.
 */
function schemeFor(value: string): string {
  const host = value.split('/')[0].toLowerCase();
  const isLocal =
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/.test(host) ||
    /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) ||
    host.endsWith('.local');
  return isLocal ? 'http' : 'https';
}

export interface EndpointAdvice {
  /** The URL the next request will actually go to. */
  resolved: string;
  /** True when the entered value was a base that had to be completed. */
  completed: boolean;
  /** Set when the browser will refuse the request outright. */
  blocked?: string;
}

export function endpointAdvice(provider: AiProviderConfig): EndpointAdvice {
  const resolved = resolveEndpoint(provider);
  const entered = provider.endpoint.trim();
  const advice: EndpointAdvice = { resolved, completed: Boolean(entered) && resolved !== entered };

  if (resolved && !/^https?:\/\//i.test(resolved)) {
    advice.blocked = 'Only http and https endpoints can be called from a web page.';
  } else if (
    resolved &&
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    resolved.startsWith('http://') &&
    !isLocalUrl(resolved)
  ) {
    advice.blocked = 'This page is served over https, so browsers block plain-http endpoints (mixed content). Use an https URL or serve X-Ray over http.';
  }
  return advice;
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/)/i.test(url);
}

/**
 * A failed fetch tells a browser page almost nothing: DNS failures, refused
 * connections, blocked mixed content and a rejected CORS preflight all arrive
 * as the same opaque TypeError. Rather than guess, explain what each of those
 * means for the endpoint that was actually called.
 */
export function explainFetchFailure(provider: AiProviderConfig, url: string): string {
  const origin = typeof location === 'undefined' ? 'this page' : location.origin;
  const advice = endpointAdvice(provider);
  const lines: string[] = [
    `The browser could not read a response from ${url}.`,
    'Browsers report DNS failures, refused connections and rejected CORS preflights identically, so X-Ray cannot tell them apart — the Network tab of your browser devtools shows which one it was (a failed OPTIONS request means CORS).',
  ];

  if (advice.completed) {
    lines.push(`The address you entered was completed to the provider's chat path: ${url} (entered: ${provider.endpoint.trim()}).`);
  }

  if (isLocalUrl(url)) {
    lines.push(
      'That endpoint is on this machine, so the usual causes are:',
      '• the server is not running, or is on a different port than the one in the URL;',
      `• it does not allow requests from this page's origin (${origin}) — most local AI servers are closed to browsers by default:`,
      `     Ollama      start it with OLLAMA_ORIGINS=${origin} (or OLLAMA_ORIGINS=*)`,
      '     LM Studio   turn on “Enable CORS” in the server settings',
      `     vLLM        add --allowed-origins ${origin}`,
      '     llama.cpp   add --host 0.0.0.0 and allow the origin in your proxy',
    );
  } else {
    lines.push(
      'The endpoint is remote, so the usual causes are:',
      '• the host does not resolve, or refused the connection (check the port and the path);',
      '• it does not send CORS headers for browsers, so the preflight was rejected — a server built for server-to-server calls cannot be called from a web page;',
      '• a VPN, proxy or firewall blocked the request.',
    );
  }

  if (advice.blocked) lines.push(`• ${advice.blocked}`);
  lines.push(
    'OpenAI, Anthropic and OpenRouter allow direct browser requests. Any other endpoint needs a proxy in front of it that sends Access-Control-Allow-Origin.',
    'Use “Test Connection” in Settings after changing the URL — it reports the same detail without sending your code.',
  );
  return lines.join('\n');
}

/**
 * A local model can take a couple of minutes to load on the first call, so the
 * first wait is generous. The idle window only has to be longer than the gap
 * between two streamed tokens, so it can be much shorter.
 */
const FIRST_ANSWER_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * A request that dies quietly is the worst failure in a chat panel: the answer
 * never arrives and nothing says why. This aborts the fetch when the endpoint
 * stops answering, so the stall becomes an error message with advice attached.
 */
function createStallGuard(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  arm(FIRST_ANSWER_TIMEOUT_MS);

  return {
    signal: controller.signal,
    /** Restarts the clock — call for every chunk of the answer. */
    keepAlive: () => arm(STREAM_IDLE_TIMEOUT_MS),
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function explainStall(url: string, firstAnswer: boolean): string {
  const seconds = Math.round((firstAnswer ? FIRST_ANSWER_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS) / 1000);
  return [
    firstAnswer
      ? `${url} accepted the connection but sent nothing for ${seconds}s, so X-Ray stopped waiting.`
      : `${url} stopped sending data mid-answer (nothing for ${seconds}s), so X-Ray stopped waiting. The text above is what arrived.`,
    'A local model that is still loading, a model that has crashed, or a proxy holding the stream open all look like this.',
    'Try again, raise the model\u2019s context/load time, or pick a smaller model.',
  ].join('\n');
}

export async function sendChat({ provider, messages, signal, onToken }: SendChatOptions): Promise<ChatResult> {
  const { url, init } = buildRequest(provider, messages, true);
  const stall = createStallGuard(signal);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: stall.signal });
  } catch (err) {
    const timedOut = stall.timedOut();
    stall.dispose();
    if (signal?.aborted) throw new AiError('Request cancelled.');
    if (timedOut) throw new AiError('The endpoint did not answer.', explainStall(url, true));
    throw new AiError('Could not reach the endpoint.', explainFetchFailure(provider, url));
  }

  if (!response.ok) {
    stall.dispose();
    throw await toApiError(response);
  }

  try {
    if (!response.body || !onToken) {
      const json = await safeJson(response);
      const text = extractNonStreaming(provider, json);
      return { text, usage: extractUsage(provider, json), model: provider.model };
    }
    return await streamResponse(provider, response.body, (chunk) => {
      stall.keepAlive();
      onToken(chunk);
    });
  } catch (err) {
    if (stall.timedOut()) throw new AiError('The endpoint stopped responding.', explainStall(url, false));
    throw err;
  } finally {
    stall.dispose();
  }
}

async function streamResponse(provider: AiProviderConfig, body: ReadableStream<Uint8Array>, onToken: (chunk: string) => void): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: ChatUsage = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = handleEvent(provider, event, onToken);
      if (parsed) {
        text += parsed.text;
        usage = { ...usage, ...parsed.usage };
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) {
    const parsed = handleEvent(provider, buffer, onToken);
    if (parsed) text += parsed.text;
  }
  return { text, usage, model: provider.model };
}

function handleEvent(provider: AiProviderConfig, event: string, onToken: (chunk: string) => void): { text: string; usage: ChatUsage } | null {
  const dataLines = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;

  let text = '';
  let usage: ChatUsage = {};
  for (const line of dataLines) {
    if (!line || line === '[DONE]') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    if (provider.kind === 'anthropic') {
      const record = json as { type?: string; delta?: { text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
      if (record.type === 'content_block_delta' && record.delta?.text) {
        text += record.delta.text;
        onToken(record.delta.text);
      }
      if (record.usage) usage = { inputTokens: record.usage.input_tokens, outputTokens: record.usage.output_tokens };
    } else {
      const record = json as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = record.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onToken(delta);
      }
      if (record.usage) usage = { inputTokens: record.usage.prompt_tokens, outputTokens: record.usage.completion_tokens };
    }
  }
  return { text, usage };
}

export async function testConnection(provider: AiProviderConfig): Promise<{ ok: boolean; message: string; detail?: string }> {
  if (!provider.endpoint) return { ok: false, message: 'No endpoint configured.' };
  if (!provider.model) return { ok: false, message: 'No model configured.' };

  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
    { role: 'user', content: 'ping' },
  ];
  const { url, init } = buildRequest(provider, messages, false);
  const stall = createStallGuard(undefined);
  try {
    const response = await fetch(url, { ...init, body: stripStream(init.body), signal: stall.signal });
    if (!response.ok) {
      const error = await toApiError(response);
      return { ok: false, message: error.message, detail: `${error.detail ? `${error.detail}\n` : ''}Requested: ${url}` };
    }
    const json = await safeJson(response);
    // A chatty endpoint may ignore the probe and answer properly; collapse it
    // so the one-line result stays readable.
    const text = extractNonStreaming(provider, json).replace(/\s+/g, ' ').trim();
    return {
      ok: true,
      message: text ? `Connected — model replied “${text.slice(0, 60)}”.` : 'Connected.',
      detail: `Requested: ${url}`,
    };
  } catch {
    const timedOut = stall.timedOut();
    return {
      ok: false,
      message: timedOut ? 'The endpoint did not answer.' : 'Could not reach the endpoint.',
      detail: timedOut ? explainStall(url, true) : explainFetchFailure(provider, url),
    };
  } finally {
    stall.dispose();
  }
}

function buildRequest(provider: AiProviderConfig, messages: ChatMessage[], stream: boolean): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const target = resolveEndpoint(provider);

  if (provider.kind === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Required for direct browser access to the Messages API.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: provider.model,
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      messages: conversation,
      stream,
    };
    if (system) body.system = system;
    return { url: target, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: provider.temperature,
    max_tokens: provider.maxTokens,
    stream,
  };
  return { url: target, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

function stripStream(body: BodyInit | null | undefined): BodyInit | undefined {
  if (typeof body !== 'string') return body ?? undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    delete parsed.stream;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function extractNonStreaming(provider: AiProviderConfig, json: unknown): string {
  if (provider.kind === 'anthropic') {
    const record = json as { content?: Array<{ type?: string; text?: string }> };
    return (record.content ?? []).filter((part) => part.type === 'text' || part.text).map((part) => part.text ?? '').join('');
  }
  const record = json as { choices?: Array<{ message?: { content?: string }; text?: string }> };
  return record.choices?.[0]?.message?.content ?? record.choices?.[0]?.text ?? '';
}

function extractUsage(provider: AiProviderConfig, json: unknown): ChatUsage {
  if (provider.kind === 'anthropic') {
    const record = json as { usage?: { input_tokens?: number; output_tokens?: number } };
    return { inputTokens: record.usage?.input_tokens, outputTokens: record.usage?.output_tokens };
  }
  const record = json as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { inputTokens: record.usage?.prompt_tokens, outputTokens: record.usage?.completion_tokens };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function toApiError(response: Response): Promise<AiError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 400);
  } catch {
    detail = '';
  }
  const status = response.status;
  if (status === 401 || status === 403) {
    return new AiError('The endpoint rejected the credentials.', detail, status);
  }
  if (status === 404) {
    return new AiError('The endpoint or model was not found.', detail, status);
  }
  if (status === 429) {
    return new AiError('Rate limited by the provider.', detail, status);
  }
  if (status >= 500) {
    return new AiError(`The provider returned a server error (${status}).`, detail, status);
  }
  return new AiError(`Request failed with status ${status}.`, detail, status);
}

