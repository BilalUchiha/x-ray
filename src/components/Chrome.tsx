import { useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeKind, NodeKind } from '../core/types';
import type { SearchResult } from '../core/search/search';
import { edgeColor, kindColor, kindLabel, THEME } from '../graph/theme';
import { activeProvider, isConfigured } from '../core/settings/aiSettings';
import {
  canRescan,
  clearSearch,
  goHome,
  rescan,
  runSearch,
  selectNode,
  setNav,
  toggleEdgeKind,
  openWarnings,
} from '../state/actions';
import { useAppState, type NavSection } from '../state/store';

// --- icons ----------------------------------------------------------------

const ICONS: Record<string, string> = {
  overview: 'M3 12h5l2 6 4-14 2 8h5',
  structure: 'M4 5h6v6H4zM14 13h6v6h-6zM7 11v6h7',
  dependencies: 'M6 6h5M6 18h5M15 12h5M11 6c2 0 2 6 4 6',
  impact: 'M12 3v10M12 17v.5M4 21h16',
  ai: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2M18 12h2M12 4v2M12 18v2',
  search: 'M10.5 4a6.5 6.5 0 104.4 11.3L19 19.5',
  home: 'M4 11l8-7 8 7v9h-6v-5h-4v5H4z',
};

function Icon({ name, size = 13 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.overview} />
    </svg>
  );
}

// --- top bar --------------------------------------------------------------

export function TopBar() {
  const state = useAppState();
  const provider = activeProvider(state.aiSettings);
  const connected = isConfigured(provider);
  const warningCount = state.session?.analysis.warnings.length ?? 0;

  return (
    <header className="topbar">
      <button type="button" className="btn ghost sm" onClick={goHome} title="Back to the welcome screen">
        <Icon name="home" size={12} /> Home
      </button>
      <div className="brand">
        X<span>—</span>RAY
      </div>
      <div className="brand-sub nowrap" title={state.session?.analysis.name}>
        {state.session?.analysis.name ?? 'no project'}
      </div>

      <SearchBox />

      <div className="spacer" />

      {state.session && !state.sourceAvailable && <span className="tag warn">source not loaded</span>}
      {warningCount > 0 && (
        <button
          type="button"
          className="btn ghost sm warn-text"
          onClick={openWarnings}
          title="Show files X-Ray could not fully analyse"
        >
          {warningCount} warning{warningCount === 1 ? '' : 's'}
        </button>
      )}
      <button
        type="button"
        className="btn sm"
        onClick={rescan}
        disabled={!canRescan()}
        title={canRescan() ? 'Re-read the folder and rebuild the graph' : 'Re-select the folder to rescan'}
      >
        Rescan
      </button>
      <span className={`status-pill ${connected ? 'on' : 'off'}`} title={connected ? `${provider?.label} · ${provider?.model}` : 'No AI provider configured'}>
        <span className="led" />
        {connected ? `AI ${provider?.label}` : 'AI off'}
      </span>
      <span className="status-pill local" title="Your project files stay on this computer. AI requests are sent only to the endpoint you configure.">
        <span className="led" />
        Local analysis
      </span>
    </header>
  );
}

// --- search ---------------------------------------------------------------

function SearchBox() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const results = state.searchResults;

  const choose = (result: SearchResult) => {
    selectNode(result.nodeId);
    setOpen(false);
  };

  return (
    <div className="search-box" ref={wrapRef}>
      <span className="search-icon">
        <Icon name="search" size={11} />
      </span>
      <input
        className="input"
        placeholder="Search codebase…"
        value={state.searchQuery}
        disabled={!state.session}
        onChange={(event) => {
          runSearch(event.target.value);
          setOpen(true);
          setHot(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            clearSearch();
            setOpen(false);
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHot((value) => Math.min(value + 1, results.length - 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHot((value) => Math.max(value - 1, 0));
          }
          if (event.key === 'Enter' && results[hot]) choose(results[hot]);
        }}
      />
      {open && results.length > 0 && (
        <div className="search-results">
          {results.map((result, index) => (
            <button
              type="button"
              key={result.nodeId}
              className={`search-hit ${index === hot ? 'hot' : ''}`}
              onMouseEnter={() => setHot(index)}
              onClick={() => choose(result)}
            >
              <span className="kind-dot" style={{ background: kindColor(result.kind as NodeKind) }} />
              <span style={{ minWidth: 0 }}>
                <div className="hit-name nowrap">{result.name}</div>
                {result.match === 'content' && result.snippet ? (
                  <div className="hit-path nowrap">{result.snippet}</div>
                ) : (
                  result.filePath && <div className="hit-path nowrap">{result.filePath}</div>
                )}
              </span>
              <span className="hit-kind">{kindLabel(result.kind as NodeKind)}</span>
            </button>
          ))}
        </div>
      )}
      {open && state.searchQuery.trim().length >= 2 && results.length === 0 && (
        <div className="search-results">
          <div className="empty">No files, classes, interfaces or methods matched “{state.searchQuery}”.</div>
        </div>
      )}
    </div>
  );
}

// --- navigation rail ------------------------------------------------------

interface RailEntry {
  id: NavSection;
  label: string;
  icon: string;
}

const RAIL: RailEntry[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'structure', label: 'Structure', icon: 'structure' },
  { id: 'dependencies', label: 'Dependencies', icon: 'dependencies' },
  { id: 'impact', label: 'Impact', icon: 'impact' },
  { id: 'ai', label: 'Ask the code', icon: 'ai' },
];

export function NavRail() {
  const state = useAppState();
  const counts = useMemo(() => {
    if (!state.session) return {} as Partial<Record<NavSection, string>>;
    const stats = state.session.analysis.stats;
    return {
      overview: `${stats.sourceFiles}`,
      structure: `${stats.folders}`,
      dependencies: `${stats.relationships}`,
      impact: state.selectedNodeId ? 'ready' : '—',
      ai: `${state.chat.filter((turn) => turn.role === 'assistant' && !turn.error).length}`,
    } as Partial<Record<NavSection, string>>;
  }, [state.session, state.selectedNodeId, state.chat]);

  return (
    <nav className="rail">
      <div className="rail-group">Explore</div>
      {RAIL.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`rail-item ${state.nav === entry.id ? 'active' : ''}`}
          onClick={() => setNav(entry.id)}
        >
          <span className="rail-icon">
            <Icon name={entry.icon} size={13} />
          </span>
          <span className="rail-label">{entry.label}</span>
          {counts[entry.id] !== undefined && <span className="count">{counts[entry.id]}</span>}
        </button>
      ))}
      <div className="rail-group">Configuration</div>
      <button
        type="button"
        className={`rail-item ${state.nav === 'settings' ? 'active' : ''}`}
        onClick={() => setNav('settings')}
      >
        <span className="rail-icon">
          <Icon name="settings" size={13} />
        </span>
        <span className="rail-label">Settings</span>
        {state.aiSettings.providers.length > 0 && <span className="count">{state.aiSettings.providers.length}</span>}
      </button>

      <div className="spacer" />
      <div className="rail-footer" style={{ color: THEME.dim }}>
        Your project files stay on this computer.
        <br />
        AI requests go only to the endpoint you configure.
      </div>
    </nav>
  );
}

// --- legend ---------------------------------------------------------------

export function GraphLegend({ kinds, edgeKinds }: { kinds: NodeKind[]; edgeKinds: EdgeKind[] }) {
  const state = useAppState();
  const uniqueKinds = Array.from(new Set(kinds));
  const uniqueEdges = Array.from(new Set(edgeKinds)).filter((kind) => kind !== 'contains');

  return (
    <div className="legend">
      {uniqueKinds.slice(0, 7).map((kind) => (
        <span key={kind} className="legend-item" style={{ cursor: 'default' }}>
          <span className="kind-dot" style={{ background: kindColor(kind) }} />
          {kindLabel(kind)}
        </span>
      ))}
      <span style={{ width: 1, height: 12, background: 'var(--border-strong)' }} />
      {uniqueEdges.slice(0, 6).map((kind) => {
        const off = state.hiddenEdgeKinds.has(kind);
        return (
          <button
            key={kind}
            type="button"
            className={`legend-item ${off ? 'muted-off' : ''}`}
            style={{ background: 'transparent', border: 'none', padding: 0 }}
            onClick={() => toggleEdgeKind(kind)}
            title={off ? 'Show this relationship type' : 'Hide this relationship type'}
          >
            <span className="legend-line" style={{ background: edgeColor(kind) }} />
            {kind.replace('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}


