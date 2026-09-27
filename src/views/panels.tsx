import { useMemo } from 'react';
import { formatBytes } from '../core/analysis/analyze';
import { APP_KIND_LABELS } from '../core/graph/apps';
import { kindColor, kindLabel } from '../graph/theme';
import type { CodeNode, EdgeKind } from '../core/types';
import {
  clearHighlight,
  highlightDependencies,
  highlightImpact,
  highlightNodes,
  selectNode,
  setImpactDepth,
  toggleExpand,
} from '../state/actions';
import { useAppState } from '../state/store';

const DEPTH_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: 'All', value: 0 },
];

// --- overview -------------------------------------------------------------

export function OverviewPanel() {
  const state = useAppState();
  const session = state.session;
  if (!session) return null;
  const { stats, languages, groups } = session.analysis;
  const apps = session.analysis.apps ?? [];

  // Groups arrive ordered by app, so a single pass yields the section list.
  const appSections = useMemo(() => {
    const out: Array<{ appId: string; label: string; kindLabel?: string; groups: typeof groups }> = [];
    for (const group of groups) {
      const last = out[out.length - 1];
      if (last && last.appId === group.appId) {
        last.groups.push(group);
        continue;
      }
      const app = apps.find((entry) => entry.path === group.appId);
      out.push({
        appId: group.appId,
        label: group.appLabel || session.analysis.name,
        kindLabel: app ? APP_KIND_LABELS[app.kind] : undefined,
        groups: [group],
      });
    }
    return out;
  }, [apps, groups, session.analysis.name]);

  const hubs = useMemo(() => {
    const incoming = new Map<string, number>();
    for (const edge of session.analysis.graph.edges) {
      if (edge.derived || edge.kind === 'contains') continue;
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
    return Array.from(incoming.entries())
      .map(([id, count]) => ({ node: session.index.nodeById.get(id), count }))
      .filter((entry): entry is { node: CodeNode; count: number } => Boolean(entry.node))
      .filter((entry) => entry.node.kind !== 'method' && entry.node.kind !== 'property' && entry.node.kind !== 'field')
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [session]);

  return (
    <div>
      <div className="ins-section">
        <div className="section-title rule">Codebase</div>
        <div className="kpi-grid">
          <Kpi value={stats.sourceFiles} label="source files" />
          <Kpi value={stats.classes} label="classes" />
          <Kpi value={stats.interfaces} label="interfaces" />
          <Kpi value={stats.methods} label="methods" />
          <Kpi value={stats.properties + stats.fields} label="props / fields" />
          <Kpi value={stats.relationships} label="relationships" />
        </div>
        <div className="split-note" style={{ marginTop: 8 }}>
          {stats.totalFiles.toLocaleString()} files scanned · {stats.folders.toLocaleString()} folders ·{' '}
          {stats.totalLines.toLocaleString()} lines · {formatBytes(stats.totalBytes)} · parsed in{' '}
          {(session.analysis.durationMs / 1000).toFixed(1)}s
        </div>
      </div>

      <div className="ins-section">
        <div className="section-title rule">Languages</div>
        {languages.slice(0, 8).map((language) => (
          <div key={language.language} className="lang-row">
            <span className="lang-name nowrap">{language.label}</span>
            <span className="lang-bar">
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${Math.max(language.percent, 1.5)}%`, background: langColor(language.language) }}
                />
              </span>
            </span>
            <span className="lang-pct">{language.percent}%</span>
          </div>
        ))}
        <div className="split-note">Percentages are by line count of the files X-Ray read.</div>
      </div>

      <div className="ins-section">
        <div className="section-title rule">Projects &amp; layers</div>
        <div className="split-note" style={{ marginBottom: 8 }}>
          Detected from build files ({apps.length > 0 ? `${apps.length} found` : 'none found — treated as one folder'}). Layers
          are inferred from naming conventions and folder names, never spanning two projects.
        </div>
        {appSections.map((section) => (
          <div key={section.appId || 'root'} style={{ marginBottom: 8 }}>
            <div className="split-note" style={{ marginBottom: 4, fontWeight: 600 }}>
              {section.label}
              {section.kindLabel && <span className="dim" style={{ fontWeight: 400 }}> · {section.kindLabel}</span>}
            </div>
            <ul className="list-plain">
              {section.groups.map((group) => (
                <li key={group.id}>
                  <button type="button" className="link-row" onClick={() => { toggleExpand(group.id); selectNode(null); }}>
                    <span className="kind-dot" style={{ background: '#4dd0c7' }} />
                    <span className="lr-name">{group.label}</span>
                    <span className="li-meta">{group.memberIds.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="ins-section">
        <div className="section-title rule">Most depended-on components</div>
        {hubs.length === 0 ? (
          <div className="dim">No incoming dependencies were detected.</div>
        ) : (
          hubs.map(({ node, count }) => (
            <button type="button" key={node.id} className="link-row" onClick={() => selectNode(node.id)}>
              <span className="kind-dot" style={{ background: kindColor(node.kind) }} />
              <span className="lr-name nowrap">{node.name}</span>
              <span className="lr-file">{count} in</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function Kpi({ value, label }: { value: number; label: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{value.toLocaleString()}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function langColor(language: string): string {
  const map: Record<string, string> = {
    csharp: '#4da3ff',
    typescript: '#4dd0c7',
    javascript: '#f0b429',
    sql: '#a78bfa',
    css: '#f472b6',
    html: '#fb923c',
    json: '#8b98a5',
    csproj: '#34d399',
    markdown: '#7d8b9c',
  };
  return map[language] ?? '#5b6674';
}

// --- structure ------------------------------------------------------------

export function StructurePanel() {
  const state = useAppState();
  const session = state.session;
  if (!session) return null;

  const rootFolders = session.analysis.graph.nodes
    .filter((node) => node.kind === 'folder' && node.parentId === 'project')
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="ins-section">
        <div className="section-title rule">Folder tree</div>
        <div className="split-note" style={{ marginBottom: 8 }}>
          Click a folder to show its files on the map and in this tree.
        </div>
        {rootFolders.map((folder) => (
          <FolderRow key={folder.id} folderId={folder.id} depth={0} />
        ))}
      </div>
    </div>
  );
}

function FolderRow({ folderId, depth }: { folderId: string; depth: number }) {
  const state = useAppState();
  const session = state.session;
  if (!session) return null;
  const folder = session.index.nodeById.get(folderId);
  if (!folder) return null;

  const children = session.index.childrenOf.get(folderId) ?? [];
  const subFolders = children
    .map((id) => session.index.nodeById.get(id))
    .filter((node): node is CodeNode => Boolean(node) && node!.kind === 'folder')
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = children
    .map((id) => session.index.nodeById.get(id))
    .filter((node): node is CodeNode => Boolean(node) && node!.kind === 'file');
  const expanded = state.expandedGroups.has(folderId);

  return (
    <div>
      <button
        type="button"
        className="link-row"
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => toggleExpand(folderId)}
      >
        <span className="dim">{expanded ? '▾' : '▸'}</span>
        <span className="lr-name">{folder.name}</span>
        <span className="li-meta">{files.length} files</span>
      </button>
      {expanded && (
        <>
          {subFolders.map((sub) => (
            <FolderRow key={sub.id} folderId={sub.id} depth={depth + 1} />
          ))}
          {files.slice(0, 60).map((file) => (
            <button
              type="button"
              key={file.id}
              className={`link-row ${state.selectedNodeId === file.id ? 'selected' : ''}`}
              style={{ paddingLeft: 4 + (depth + 1) * 12 }}
              onClick={() => selectNode(file.id)}
            >
              <span className="kind-dot" style={{ background: kindColor('file') }} />
              <span className="lr-name nowrap">{file.name}</span>
              <span className="li-meta">{file.lineCount ?? 0} ln</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// --- dependencies ---------------------------------------------------------

export function DependenciesPanel() {
  const state = useAppState();
  const session = state.session;
  if (!session) return null;

  const { edgeCounts, topIncoming, topOutgoing } = useMemo(() => {
    const counts = new Map<EdgeKind, number>();
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const edge of session.analysis.graph.edges) {
      if (edge.derived) continue;
      if (edge.kind !== 'contains') counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
      if (edge.kind === 'contains') continue;
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    }
    const rank = (map: Map<string, number>) =>
      Array.from(map.entries())
        .map(([id, count]) => ({ node: session.index.nodeById.get(id), count }))
        .filter((entry): entry is { node: CodeNode; count: number } => Boolean(entry.node))
        .filter((entry) => entry.node.kind !== 'method' && entry.node.kind !== 'property' && entry.node.kind !== 'field')
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
    return { edgeCounts: counts, topIncoming: rank(incoming), topOutgoing: rank(outgoing) };
  }, [session]);

  return (
    <div>
      <div className="ins-section">
        <div className="section-title rule">Relationship types</div>
        {Array.from(edgeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([kind, count]) => (
            <div key={kind} className="row between" style={{ padding: '4px 0', fontSize: 12 }}>
              <span className="row" style={{ gap: 7 }}>
                <span className="kind-dot" style={{ background: kindColor('class'), opacity: 0.4 }} />
                {kind.replace('_', ' ')}
              </span>
              <span className="mono dim">{count.toLocaleString()}</span>
            </div>
          ))}
        <div className="split-note" style={{ marginTop: 6 }}>
          Only relationships the parser could actually see are counted. Nothing is inferred for appearances.
        </div>
      </div>

      <div className="ins-section">
        <div className="section-title rule">Most depended on</div>
        {topIncoming.map(({ node, count }) => (
          <button
            type="button"
            key={node.id}
            className="link-row"
            onClick={() => {
              selectNode(node.id);
              highlightNodes([node.id], `${node.name} is depended on by ${count} components`);
            }}
          >
            <span className="kind-dot" style={{ background: kindColor(node.kind) }} />
            <span className="lr-name nowrap">{node.name}</span>
            <span className="lr-file">{count} in</span>
          </button>
        ))}
      </div>

      <div className="ins-section">
        <div className="section-title rule">Most dependencies</div>
        {topOutgoing.map(({ node, count }) => (
          <button type="button" key={node.id} className="link-row" onClick={() => selectNode(node.id)}>
            <span className="kind-dot" style={{ background: kindColor(node.kind) }} />
            <span className="lr-name nowrap">{node.name}</span>
            <span className="lr-file">{count} out</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- impact ---------------------------------------------------------------

export function ImpactPanel() {
  const state = useAppState();
  const session = state.session;
  const node = state.selectedNodeId && session ? session.index.nodeById.get(state.selectedNodeId) : null;

  if (!session) return null;
  if (!node) {
    return <div className="empty">Select a component on the map to analyse what depends on it.</div>;
  }

  const impact = state.impact;

  return (
    <div>
      <div className="ins-section">
        <div className="row between">
          <div className="section-title">What depends on this?</div>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <span className="dim">Depth</span>
          <span className="seg">
            {DEPTH_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.label}
                className={state.impactDepth === option.value ? 'active' : ''}
                onClick={() => setImpactDepth(option.value)}
              >
                {option.label}
              </button>
            ))}
          </span>
        </div>
        <div className="notice accent" style={{ marginTop: 10 }}>
          <span>ⓘ</span>
          <div>
            Static dependency analysis. Components listed as <em>potentially affected</em> are reachable through
            references, calls, inheritance and construction — runtime behaviour is not known.
          </div>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn sm primary" onClick={highlightImpact}>
            Highlight dependents
          </button>
          <button type="button" className="btn sm" onClick={highlightDependencies}>
            Highlight dependencies
          </button>
          <button type="button" className="btn sm ghost" onClick={clearHighlight}>
            Clear
          </button>
        </div>
      </div>

      {!impact ? (
        <div className="dim">Computing…</div>
      ) : (
        <>
          <div className="ins-section">
            <div className="section-title rule">Direct dependencies ({impact.dependencies.length})</div>
            <ImpactList members={impact.dependencies} empty="No outgoing dependencies detected." />
          </div>
          <div className="ins-section">
            <div className="section-title rule">Directly dependent ({impact.dependents.length})</div>
            <ImpactList members={impact.dependents} empty="Nothing in this folder directly depends on it." />
          </div>
          <div className="ins-section">
            <div className="section-title rule">Potentially affected ({impact.indirect.length})</div>
            <ImpactList members={impact.indirect} empty="No indirect dependents within the selected depth." />
          </div>
        </>
      )}
    </div>
  );
}

function ImpactList({
  members,
  empty,
}: {
  members: Array<{ nodeId: string; name: string; kind: CodeNode['kind']; filePath?: string; distance: number }>;
  empty: string;
}) {
  if (members.length === 0) return <div className="dim">{empty}</div>;
  return (
    <ul className="list-plain">
      {members.slice(0, 40).map((member) => (
        <li key={member.nodeId}>
          <button type="button" className="link-row" onClick={() => selectNode(member.nodeId)}>
            <span className="kind-dot" style={{ background: kindColor(member.kind) }} />
            <span className="lr-name nowrap">{member.name}</span>
            <span className="lr-file">{member.distance > 1 ? `+${member.distance}` : kindLabel(member.kind)}</span>
          </button>
        </li>
      ))}
      {members.length > 40 && <li className="dim">+{members.length - 40} more</li>}
    </ul>
  );
}

// --- warnings -------------------------------------------------------------

export function WarningsTable() {
  const state = useAppState();
  const warnings = state.session?.analysis.warnings ?? [];
  if (warnings.length === 0) {
    return <div className="ok-text" style={{ fontSize: 12 }}>No warnings — every scanned file was read and parsed.</div>;
  }
  const byKind = new Map<string, number>();
  for (const warning of warnings) byKind.set(warning.kind, (byKind.get(warning.kind) ?? 0) + 1);
  return (
    <div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 9 }}>
        {Array.from(byKind.entries()).map(([kind, count]) => (
          <span key={kind} className="tag warn">
            {count} {kind.replace('-', ' ')}
          </span>
        ))}
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        <table className="warning-table">
          <tbody>
            {warnings.slice(0, 200).map((warning, index) => (
              <tr key={`${warning.path}-${index}`}>
                <td>{warning.kind}</td>
                <td>{warning.path}</td>
                <td>{warning.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
