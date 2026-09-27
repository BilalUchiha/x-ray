import { useMemo } from 'react';
import { computeImpact } from '../core/analysis/impact';
import { kindColor, kindLabel } from '../graph/theme';
import {
  clearHighlight,
  highlightImpact,
  highlightNodes,
  selectNode,
  setNav,
} from '../state/actions';
import { useAppState } from '../state/store';

export function NodeDetails() {
  const state = useAppState();
  const session = state.session;
  const nodeId = state.selectedNodeId;
  const node = nodeId && session ? session.index.nodeById.get(nodeId) : null;

  const impact = useMemo(() => {
    if (!session || !nodeId) return null;
    return computeImpact(session, nodeId, { depth: 1 });
  }, [session, nodeId]);

  if (!session) return null;

  if (!node) {
    return (
      <div className="detail-strip">
        <div className="detail-inner">
          <div className="detail-col" style={{ flex: 1 }}>
            <div className="section-title">Selected component</div>
            {/* Kept to a single line: this strip sits under the whole app, so an
                empty state that wraps would eat the stage above it. */}
            <div
              className="muted"
              style={{ marginTop: 4 }}
              title="Click a box on the map to inspect it. Click the +/− at the right of a box to hide or reveal everything under it."
            >
              Click a box to inspect it · the +/− on a box hides or reveals what is inside it
            </div>
          </div>
          <div className="detail-col" style={{ minWidth: 240 }}>
            <div className="section-title">Codebase</div>
            <div className="row" style={{ gap: 14, marginTop: 5, flexWrap: 'wrap' }}>
              <MiniStat value={session.analysis.stats.totalFiles} label="files" />
              <MiniStat value={session.analysis.stats.classes} label="classes" />
              <MiniStat value={session.analysis.stats.interfaces} label="interfaces" />
              <MiniStat value={session.analysis.stats.methods} label="methods" />
              <MiniStat value={session.analysis.stats.relationships} label="relationships" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const members = (session.index.childrenOf.get(node.id) ?? [])
    .map((id) => session.index.nodeById.get(id))
    .filter((child): child is NonNullable<typeof child> => Boolean(child))
    .filter((child) => child.kind === 'method' || child.kind === 'constructor' || child.kind === 'function' || child.kind === 'property');

  const methods = members.filter((member) => member.kind === 'method' || member.kind === 'constructor' || member.kind === 'function');
  const fields = members.filter((member) => member.kind === 'property');

  return (
    <div className="detail-strip">
      <div className="detail-inner">
        <div className="detail-col" style={{ minWidth: 280, maxWidth: 340 }}>
          <div className="detail-head">
            <span className="kind-dot" style={{ background: kindColor(node.kind) }} />
            <span className="detail-title nowrap">{node.name}</span>
            <span className="tag">{kindLabel(node.kind)}</span>
          </div>
          {node.qualifiedName && node.qualifiedName !== node.name && (
            <div className="detail-sub nowrap">{node.qualifiedName}</div>
          )}
          {node.filePath && (
            <div className="detail-sub nowrap" title={node.filePath} style={{ color: 'var(--muted)' }}>
              {node.filePath}
              {node.startLine ? `:${node.startLine}` : ''}
            </div>
          )}
          {node.signature && <div className="mono dim nowrap" style={{ marginTop: 3 }}>{node.signature}</div>}

          <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => { setNav('impact'); }}>
              Show impact
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const ids = [node.id, ...(impact?.dependencies ?? []).map((d) => d.nodeId)];
                highlightNodes(ids, `focus on ${node.name}`);
              }}
            >
              Focus neighbourhood
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setNav('ai');
              }}
            >
              Ask about this
            </button>
          </div>
          {state.highlighted.size > 0 && (
            <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} onClick={clearHighlight}>
              Clear highlight ({state.highlighted.size})
            </button>
          )}
        </div>

        <div className="detail-col" style={{ flex: 1, minWidth: 200 }}>
          <div className="section-title rule">
            Members <span className="dim">({members.length})</span>
          </div>
          {members.length === 0 ? (
            <div className="dim">No members were parsed for this component.</div>
          ) : (
            <div className="chip-list">
              {methods.slice(0, 24).map((member) => (
                <button
                  type="button"
                  key={member.id}
                  className="chip clickable"
                  onClick={() => selectNode(member.id)}
                  title={member.signature}
                >
                  {member.name}
                  <span className="dim">()</span>
                </button>
              ))}
              {fields.slice(0, 12).map((member) => (
                <span key={member.id} className="chip" title={member.signature}>
                  {member.name}
                </span>
              ))}
              {members.length > 36 && <span className="chip dim">+{members.length - 36} more</span>}
            </div>
          )}
        </div>

        <div className="detail-col" style={{ minWidth: 220 }}>
          <div className="section-title rule">
            Dependencies <span className="dim">({impact?.dependencies.length ?? 0})</span>
          </div>
          {!impact || impact.dependencies.length === 0 ? (
            <div className="dim">No outgoing dependencies were detected.</div>
          ) : (
            <div className="chip-list">
              {impact.dependencies.slice(0, 14).map((dependency) => (
                <button
                  type="button"
                  key={dependency.nodeId}
                  className="chip clickable"
                  onClick={() => selectNode(dependency.nodeId)}
                >
                  {dependency.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="detail-col" style={{ minWidth: 220 }}>
          <div className="section-title rule">
            Directly dependent <span className="dim">({impact?.dependents.length ?? 0})</span>
          </div>
          {!impact || impact.dependents.length === 0 ? (
            <div className="dim">Nothing inside this folder depends on it yet.</div>
          ) : (
            <>
              <div className="chip-list">
                {impact.dependents.slice(0, 14).map((dependent) => (
                  <button
                    type="button"
                    key={dependent.nodeId}
                    className="chip clickable"
                    onClick={() => selectNode(dependent.nodeId)}
                  >
                    {dependent.name}
                  </button>
                ))}
              </div>
              <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={highlightImpact}>
                Highlight on map
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString()}</div>
      <div className="dim" style={{ fontSize: 10.5 }}>{label}</div>
    </div>
  );
}
