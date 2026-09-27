import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { AiContext } from '../core/ai/context';
import { activeProvider, isConfigured } from '../core/settings/aiSettings';
import { kindColor } from '../graph/theme';
import {
  ask,
  cancelAsk,
  clearChat,
  focusReferencedNodes,
  selectNode,
  setNav,
  setAiError,
  toggleAiMap,
} from '../state/actions';
import { useAppState } from '../state/store';

const SUGGESTIONS = [
  'How does authentication work?',
  'Where is the database connection configured?',
  'What happens when a user logs in?',
  'Which classes handle user registration?',
  'What depends on the user service?',
];

export function AiPanel() {
  const state = useAppState();
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Follow the answer only while the reader is already at the bottom: scrolling
  // up to re-read something must not be undone by the next streamed token.
  const stickRef = useRef(true);

  const selected = state.selectedNodeId && state.session
    ? state.session.index.nodeById.get(state.selectedNodeId)
    : null;
  const provider = activeProvider(state.aiSettings);
  const connected = isConfigured(provider);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [state.chat, state.streamBuffer]);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || state.aiBusy) return;
    setDraft('');
    stickRef.current = true;
    void ask(trimmed);
  };

  return (
    <div className="ai-chat">
      <div className="stage-head" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="stage-title">Ask your codebase</span>
        {selected ? (
          <span className="tag accent">Selected: {selected.name}</span>
        ) : (
          <span className="stage-sub">No component selected — questions use codebase-wide retrieval</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost sm"
          onClick={toggleAiMap}
          title={state.aiMapOpen ? 'Hide the companion map' : 'Show the companion map'}
        >
          {state.aiMapOpen ? 'Map ▸' : '◂ Map'}
        </button>
        {state.chat.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={clearChat}>
            Clear
          </button>
        )}
      </div>

      <div
        className="ai-thread"
        ref={threadRef}
        onScroll={() => {
          const el = threadRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
      >
        {state.chat.length === 0 && (
          <>
            <div className="bubble assistant">
              <div className="bubble-role">X-Ray</div>
              <p>
                Ask about the structure of this codebase. X-Ray finds the relevant components in the graph, pulls
                only the source needed, and sends that to the endpoint you configured.
              </p>
              <p className="dim">
                Nothing is sent unless you ask a question. With no provider configured, every other part of X-Ray
                still works.
              </p>
            </div>
            <div>
              <div className="section-title" style={{ marginBottom: 7 }}>Try</div>
              <div className="chip-list">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    className="chip clickable"
                    onClick={() => submit(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {state.chat.map((turn, index) => (
          <div key={index} className={`bubble ${turn.role} ${turn.error ? 'error' : ''}`}>
            <div className="bubble-role">{turn.role === 'user' ? 'You' : 'X-Ray'}</div>
            {/* An error keeps its own line breaks, so the guidance stays readable. */}
            {turn.role !== 'assistant'
              ? turn.content
              : turn.error
                ? <div className="pre-line">{turn.content}</div>
                : <Markdown text={turn.content} />}
            {turn.role === 'assistant' && turn.referenced && turn.referenced.length > 0 && (
              <div className="ref-row">
                <div className="row between">
                  <span className="dim" style={{ fontSize: 11 }}>
                    Referenced components
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => focusReferencedNodes(turn.referenced!.map((node) => node.id))}
                  >
                    Show on map
                  </button>
                </div>
                <div className="ref-chips">
                  {turn.referenced.map((node) => (
                    <button
                      type="button"
                      key={node.id}
                      className="chip clickable"
                      onClick={() => selectNode(node.id)}
                    >
                      <span className="kind-dot" style={{ background: kindColor(node.kind), marginRight: 5 }} />
                      {node.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turn.role === 'assistant' && turn.context && <ContextSent context={turn.context} />}
          </div>
        ))}

        {state.aiBusy && (
          <div className="bubble assistant">
            <div className="bubble-role">X-Ray</div>
            {state.streamBuffer ? (
              <Markdown text={state.streamBuffer} />
            ) : (
              <span className="row" style={{ gap: 8 }}>
                <span className="spinner" /> Retrieving context and querying {provider?.label ?? 'the endpoint'}…
              </span>
            )}
            {state.aiContext && <ContextSent context={state.aiContext} live />}
          </div>
        )}

        {state.aiError && (
          <div className="notice error">
            <span>⚠</span>
            <div>{state.aiError}</div>
          </div>
        )}
      </div>

      <div className="composer">
        {!connected && (
          <div className="notice" style={{ marginBottom: 9 }}>
            <span>ⓘ</span>
            <div>
              No AI provider is ready.{' '}
              <button type="button" className="btn ghost sm" onClick={() => setNav('settings')}>
                Configure one in Settings
              </button>{' '}
              — X-Ray's structural analysis does not need it.
            </div>
          </div>
        )}
        <div className="composer-row">
          <textarea
            className="textarea"
            placeholder={selected ? `Ask anything about ${selected.name}…` : 'Ask about this codebase…'}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (state.aiError) setAiError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit(draft);
              }
            }}
            disabled={state.aiBusy}
          />
          {state.aiBusy ? (
            <button type="button" className="btn" onClick={cancelAsk}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => submit(draft)} disabled={!draft.trim()}>
              Ask
            </button>
          )}
        </div>
        <div className="split-note composer-note">⌘/Ctrl + Enter to send · only retrieved context leaves this machine</div>
      </div>
    </div>
  );
}

/**
 * What the model was given for one answer.
 *
 * This sits inside the answer it belongs to and starts closed: the transcript
 * is the point of the panel, and a list of twenty file paths above it would
 * push the conversation out of view. The summary line still shows the shape of
 * the retrieval (files, components, tokens, how much was left out), and the
 * body scrolls inside itself rather than growing without limit.
 */
function ContextSent({ context, live = false }: { context: AiContext; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const { files, nodes, estimatedTokens, excludedFiles } = context;

  return (
    <div className="ctx">
      <button
        type="button"
        className="ctx-head"
        aria-expanded={open}
        title={`${files.length} file excerpt(s), ${nodes.length} component(s), ≈${estimatedTokens.toLocaleString()} tokens sent · ${excludedFiles.toLocaleString()} of ${context.totalFiles.toLocaleString()} files were not needed · click for the list`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dim">{open ? '▾' : '▸'}</span>
        <span className="nowrap">{live ? 'Context being sent' : 'Context sent'}</span>
        {/* The fields wrap as a group rather than being clipped one by one. */}
        <span className="ctx-fields">
          <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
          <span>{nodes.length} components</span>
          <span className="mono ctx-tokens">≈{estimatedTokens.toLocaleString()} tokens</span>
          <span className="dim">{excludedFiles.toLocaleString()} left out</span>
        </span>
      </button>

      {open && (
        <div className="ctx-body">
          {files.map((file) => (
            <div key={file.path} className="context-file">
              <span className="ok-text">✓</span>
              <span className="cf-path nowrap" title={file.reason}>
                {file.path}
              </span>
              <span className="cf-meta">
                L{file.startLine}–{file.endLine} · {file.tokens} tok{file.truncated ? ' · excerpted' : ''}
              </span>
            </div>
          ))}
          {files.length === 0 && <div className="dim">No files were retrieved for this question.</div>}

          {nodes.length > 0 && (
            <details className="ctx-nodes">
              <summary>{nodes.length} components matched the question</summary>
              <div className="ctx-node-list">
                {nodes.slice(0, 20).map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    className="chip clickable"
                    title={node.reason}
                    onClick={() => selectNode(node.id)}
                  >
                    <span className="kind-dot" style={{ background: kindColor(node.kind), marginRight: 5 }} />
                    {node.name}
                  </button>
                ))}
                {nodes.length > 20 && <span className="dim">+{nodes.length - 20} more</span>}
              </div>
            </details>
          )}

          {context.notes.length > 0 && <div className="split-note">{context.notes.join(' ')}</div>}
        </div>
      )}
    </div>
  );
}
