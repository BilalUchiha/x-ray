// Endpoint resolution check.
//
// X-Ray talks to the endpoint the developer pastes into Settings, and people
// paste what the provider's docs show: a *base* URL. Posting to a base is not a
// network failure, it is a 404 that a browser can only report as "unreachable",
// so the base is completed to the provider's chat path. These are the cases
// that must keep working.
//
//   npx esbuild scripts/ai-check.ts --bundle --platform=node --format=esm --outfile=/tmp/ai.mjs && node /tmp/ai.mjs

import { resolveEndpointUrl } from '../src/core/ai/client.ts';
import type { ProviderKind } from '../src/core/settings/aiSettings.ts';

interface Case {
  kind: ProviderKind;
  entered: string;
  expected: string;
}

const CASES: Case[] = [
  // OpenAI-style: bare host, version root, or the full path.
  { kind: 'openai', entered: 'https://api.openai.com', expected: 'https://api.openai.com/v1/chat/completions' },
  { kind: 'openai', entered: 'https://api.openai.com/', expected: 'https://api.openai.com/v1/chat/completions' },
  { kind: 'openai', entered: 'https://api.openai.com/v1', expected: 'https://api.openai.com/v1/chat/completions' },
  { kind: 'openai', entered: 'https://api.openai.com/v1/', expected: 'https://api.openai.com/v1/chat/completions' },
  { kind: 'openai', entered: 'https://api.openai.com/v1/chat/completions', expected: 'https://api.openai.com/v1/chat/completions' },
  { kind: 'openai', entered: '  https://api.openai.com/v1  ', expected: 'https://api.openai.com/v1/chat/completions' },

  // Local servers: the ports people actually type, with or without a scheme.
  { kind: 'openai-compatible', entered: 'http://localhost:11434', expected: 'http://localhost:11434/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'localhost:11434', expected: 'http://localhost:11434/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'localhost:1234/v1', expected: 'http://localhost:1234/v1/chat/completions' },
  { kind: 'openai-compatible', entered: '127.0.0.1:8000', expected: 'http://127.0.0.1:8000/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'http://192.168.1.40:8080/v1', expected: 'http://192.168.1.40:8080/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'http://localhost:11434/v1/chat/completions', expected: 'http://localhost:11434/v1/chat/completions' },

  // Gateways and clouds.
  { kind: 'openai-compatible', entered: 'https://openrouter.ai/api/v1', expected: 'https://openrouter.ai/api/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'openrouter.ai/api', expected: 'https://openrouter.ai/api/v1/chat/completions' },
  { kind: 'openai-compatible', entered: 'https://my-gw.example.com/tools/llm', expected: 'https://my-gw.example.com/tools/llm/v1/chat/completions' },
  {
    kind: 'openai-compatible',
    entered: 'https://acme.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-15-preview',
    expected: 'https://acme.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-15-preview',
  },

  // Anthropic uses /v1/messages.
  { kind: 'anthropic', entered: 'https://api.anthropic.com', expected: 'https://api.anthropic.com/v1/messages' },
  { kind: 'anthropic', entered: 'https://api.anthropic.com/v1', expected: 'https://api.anthropic.com/v1/messages' },
  { kind: 'anthropic', entered: 'https://api.anthropic.com/v1/messages', expected: 'https://api.anthropic.com/v1/messages' },

  // Left alone: a full path we do not recognise, and nothing at all.
  { kind: 'openai-compatible', entered: 'http://localhost:11434/api/chat', expected: 'http://localhost:11434/api/chat' },
  { kind: 'openai', entered: '', expected: '' },
];

let failed = 0;
for (const testCase of CASES) {
  const actual = resolveEndpointUrl(testCase.kind, testCase.entered);
  const ok = actual === testCase.expected;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${testCase.kind.padEnd(18)} ${JSON.stringify(testCase.entered).padEnd(96)} -> ${actual}`,
  );
  if (!ok) console.log(`     expected ${testCase.expected}`);
}

// The advice shown in Settings has to agree with what is actually requested.
const advanced = resolveEndpointUrl('openai-compatible', 'http://localhost:11434');
const baseWarned = resolveEndpointUrl('openai', '');
console.log(`\n${advanced === 'http://localhost:11434/v1/chat/completions' ? 'ok  ' : 'FAIL'} base URL is completed before the request is built`);
console.log(`${baseWarned === '' ? 'ok  ' : 'FAIL'} an empty endpoint stays empty (Settings shows nothing, no request is sent)`);
if (advanced !== 'http://localhost:11434/v1/chat/completions' || baseWarned !== '') failed++;

console.log(failed === 0 ? `\nall ${CASES.length + 2} endpoint cases pass` : `\n!! ${failed} endpoint case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
