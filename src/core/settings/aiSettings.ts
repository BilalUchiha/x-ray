import { idbGet, idbPut, STORE_SETTINGS } from '../storage/db';

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible';

export interface AiProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Friendly name shown in the UI. */
  label: string;
  endpoint: string;
  model: string;
  /** Stored in this browser's IndexedDB only — never in the project folder. */
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

export interface AiSettings {
  providers: AiProviderConfig[];
  activeProviderId: string | null;
}

export const PROVIDER_PRESETS: Record<ProviderKind, { label: string; endpoint: string; model: string; docs: string }> = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    docs: 'Any chat-completions model id your account can use.',
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-sonnet-latest',
    docs: 'Messages API. X-Ray sends the direct-browser-access header.',
  },
  'openai-compatible': {
    label: 'OpenAI-compatible',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3.1',
    docs: 'Ollama, LM Studio, vLLM, OpenRouter, Azure OpenAI or your own gateway.',
  },
};

export function createProvider(kind: ProviderKind, existing: AiProviderConfig[]): AiProviderConfig {
  const preset = PROVIDER_PRESETS[kind];
  const used = existing.filter((p) => p.kind === kind).length;
  return {
    id: `p-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    label: used === 0 ? preset.label : `${preset.label} ${used + 1}`,
    endpoint: preset.endpoint,
    model: preset.model,
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1024,
  };
}

export const EMPTY_AI_SETTINGS: AiSettings = { providers: [], activeProviderId: null };

export async function loadAiSettings(): Promise<AiSettings> {
  try {
    const record = await idbGet<{ key: string; value: AiSettings }>(STORE_SETTINGS, 'ai');
    if (!record?.value) return EMPTY_AI_SETTINGS;
    const value = record.value;
    return {
      providers: Array.isArray(value.providers) ? value.providers : [],
      activeProviderId: value.activeProviderId ?? null,
    };
  } catch {
    return EMPTY_AI_SETTINGS;
  }
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await idbPut(STORE_SETTINGS, { key: 'ai', value: settings });
}

export function activeProvider(settings: AiSettings): AiProviderConfig | null {
  if (!settings.activeProviderId) return null;
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? null;
}

export function isConfigured(provider: AiProviderConfig | null): boolean {
  if (!provider) return false;
  if (!provider.endpoint || !provider.model) return false;
  if (provider.kind === 'openai-compatible') return true; // local servers often need no key
  return provider.apiKey.trim().length > 0;
}
