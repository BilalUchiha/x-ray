import { endpointAdvice } from '../core/ai/client';
import { PROVIDER_PRESETS, type AiProviderConfig } from '../core/settings/aiSettings';
import {
  activateProvider,
  addProvider,
  clearStoredWorkspaces,
  removeProvider,
  runConnectionTest,
  updateProvider,
} from '../state/actions';
import { useAppState } from '../state/store';
import { WarningsTable } from './panels';

export function SettingsView() {
  const state = useAppState();
  const settings = state.aiSettings;
  const warnings = state.session?.analysis.warnings.length ?? 0;

  return (
    <div className="settings">
      <div className="settings-inner">
        <h2>Settings</h2>
        <p className="lede">
          X-Ray stores everything outside your project: analysis in this browser's IndexedDB, provider settings in
          its own settings store. Your project folder is never written to.
        </p>

        <div className="section-title rule">AI providers</div>
        <p className="split-note" style={{ marginBottom: 12 }}>
          AI is optional. X-Ray works fully without it. Requests go straight from this page to the endpoint you
          enter — there is no X-Ray server in the middle.
        </p>

        {settings.providers.length === 0 && (
          <div className="notice" style={{ marginBottom: 12 }}>
            <span>ⓘ</span>
            <div>
              No providers configured yet. Add OpenAI, Anthropic, or any OpenAI-compatible endpoint (Ollama, LM
              Studio, vLLM, OpenRouter, Azure OpenAI, your own gateway).
            </div>
          </div>
        )}

        {settings.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            active={settings.activeProviderId === provider.id}
            testing={state.testingConnection}
            test={settings.activeProviderId === provider.id ? state.connectionTest : null}
          />
        ))}

        <div className="row" style={{ gap: 7, marginBottom: 22 }}>
          <button type="button" className="btn" onClick={() => addProvider('openai')}>
            + OpenAI
          </button>
          <button type="button" className="btn" onClick={() => addProvider('anthropic')}>
            + Anthropic
          </button>
          <button type="button" className="btn" onClick={() => addProvider('openai-compatible')}>
            + OpenAI-compatible
          </button>
        </div>

        <div className="section-title rule">Credential storage</div>
        <div className="notice" style={{ marginBottom: 22 }}>
          <span>⚠</span>
          <div>
            Browsers do not expose an operating-system keychain to web pages, so API keys are stored unencrypted in
            this browser profile's IndexedDB. X-Ray never writes keys into your project folder, never puts them in
            the graph, never logs them, and never includes them in the AI context. Anyone with access to this
            browser profile could read them — remove a provider here when you no longer need it.
          </div>
        </div>

        <div className="section-title rule">Analysis warnings</div>
        <p className="split-note" style={{ marginBottom: 10 }}>
          {warnings > 0
            ? `${warnings} file(s) could not be fully read or parsed. Everything else was analysed normally.`
            : 'Files X-Ray could not read, skipped as binary, or that exceeded the size limit appear here.'}
        </p>
        {state.session ? <WarningsTable /> : <div className="dim">Analyse a folder to see warnings.</div>}

        <div className="hr" />
        <div className="section-title rule">Privacy</div>
        <ul className="list-plain">
          <li>
            <span className="li-name">LOCAL ANALYSIS</span>
            <span className="li-meta">Your project files stay on this computer.</span>
          </li>
          <li>
            <span className="li-name">AI requests</span>
            <span className="li-meta">Sent only to the endpoint you configure.</span>
          </li>
          <li>
            <span className="li-name">Project folder</span>
            <span className="li-meta">Opened read-only; nothing is created or modified inside it.</span>
          </li>
          <li>
            <span className="li-name">No accounts, no sync</span>
            <span className="li-meta">X-Ray has no backend service of its own.</span>
          </li>
        </ul>
        <p className="split-note" style={{ marginTop: 10 }}>
          X-Ray makes no claims about what your chosen AI provider does with requests once they reach it.
        </p>

        <div className="hr" />
        <div className="row between" style={{ marginBottom: 10 }}>
          <div className="section-title">Stored analyses</div>
          {state.workspaces.length > 0 && (
            <button type="button" className="btn ghost sm danger" onClick={() => void clearStoredWorkspaces()}>
              Clear all
            </button>
          )}
        </div>
        <p className="split-note" style={{ marginBottom: 10 }}>
          Saved in this browser's IndexedDB, never inside your project. Rescanning a folder replaces its entry.
          Browsers do not expose absolute paths, so entries are keyed by folder name.
        </p>
        {state.workspaces.length === 0 ? (
          <div className="dim">No saved analyses yet.</div>
        ) : (
          <ul className="list-plain">
            {state.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <span className="li-name">{workspace.name}</span>
                <span className="li-meta">
                  {workspace.stats.sourceFiles} source files · {new Date(workspace.analyzedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  active,
  testing,
  test,
}: {
  provider: AiProviderConfig;
  active: boolean;
  testing: boolean;
  test: { ok: boolean; message: string; detail?: string } | null;
}) {
  const preset = PROVIDER_PRESETS[provider.kind];
  const endpoint = endpointAdvice(provider);
  return (
    <div className="provider-card">
      <div className={`provider-head ${active ? 'active' : ''}`}>
        <span className="tag accent">{preset.label}</span>
        <input
          className="input"
          style={{ maxWidth: 220, height: 27 }}
          value={provider.label}
          onChange={(event) => updateProvider(provider.id, { label: event.target.value })}
          aria-label="Provider name"
        />
        {active ? (
          <span className="status-pill on">
            <span className="led" />
            Active
          </span>
        ) : (
          <button type="button" className="btn sm" onClick={() => activateProvider(provider.id)}>
            Use this provider
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn ghost sm danger" onClick={() => removeProvider(provider.id)}>
          Remove
        </button>
      </div>

      <div className="provider-body">
        <div className="field">
          <label>API endpoint</label>
          <input
            className="input"
            value={provider.endpoint}
            spellCheck={false}
            onChange={(event) => updateProvider(provider.id, { endpoint: event.target.value })}
            placeholder={preset.endpoint}
          />
          <span className="hint">{preset.docs}</span>
        </div>

        {endpoint.resolved && (
          <div className={`endpoint-preview ${endpoint.blocked ? 'warn' : ''}`}>
            <div>
              Requests go to <code>{endpoint.resolved}</code>
            </div>
            {endpoint.blocked ? (
              <div style={{ marginTop: 3 }}>⚠ {endpoint.blocked}</div>
            ) : (
              endpoint.completed && (
                <div style={{ marginTop: 3 }}>
                  Completed from the base URL you entered — X-Ray appends the provider's chat path, so a base URL or
                  the full path both work.
                </div>
              )
            )}
          </div>
        )}

        <div className="grid-2">
          <div className="field">
            <label>API key</label>
            <input
              className="input"
              type="password"
              value={provider.apiKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
              placeholder={provider.kind === 'openai-compatible' ? 'optional for local servers' : 'sk-…'}
            />
          </div>
          <div className="field">
            <label>Model</label>
            <input
              className="input"
              value={provider.model}
              spellCheck={false}
              onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
              placeholder={preset.model}
            />
          </div>
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Max response tokens</label>
            <input
              className="input"
              type="number"
              min={64}
              max={32000}
              value={provider.maxTokens}
              onChange={(event) => updateProvider(provider.id, { maxTokens: clamp(Number(event.target.value), 64, 32000, 1024) })}
            />
          </div>
          <div className="field">
            <label>Temperature</label>
            <input
              className="input"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={provider.temperature}
              onChange={(event) => updateProvider(provider.id, { temperature: clamp(Number(event.target.value), 0, 2, 0.2) })}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => void runConnectionTest()} disabled={testing}>
            {testing ? <span className="spinner" /> : null}
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <span className="split-note">
            Sends a one-word probe to the endpoint above. Your codebase is not sent.
          </span>
        </div>

        {test && (
          <div className={`test-result ${test.ok ? 'ok' : 'fail'}`} style={{ marginTop: 10 }}>
            <strong>{test.ok ? 'Connection works' : 'Connection failed'}</strong>
            <div style={{ marginTop: 2 }}>{test.message}</div>
            {test.detail && <div className="test-detail">{test.detail}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
