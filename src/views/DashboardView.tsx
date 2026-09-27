import { useMemo } from 'react';
import { GraphCanvas } from '../graph/GraphCanvas';
import { composeGraphView, type GraphView } from '../graph/viewModel';
import { GraphLegend, NavRail, TopBar } from '../components/Chrome';
import { NodeDetails } from '../components/NodeDetails';
import {
  clearHighlight,
  collapseAll,
  expandAllLayers,
  hoverNode,
  selectNode,
  toggleExpand,
  toggleInspector,
} from '../state/actions';
import { useAppState } from '../state/store';
import { AiPanel } from './AiPanel';
import { SettingsView } from './SettingsView';
import { DependenciesPanel, ImpactPanel, OverviewPanel, StructurePanel } from './panels';

const EMPTY_VIEW: GraphView = { nodes: [], edges: [], kinds: [], edgeKinds: [], hiddenNodes: 0, totalNodes: 0 };

export function DashboardView() {
  const state = useAppState();
  const session = state.session;

  const view = useMemo<GraphView>(() => {
    if (!session || state.nav === 'settings') return EMPTY_VIEW;
    const composed = composeGraphView(session, {
      mode: state.nav === 'structure' ? 'structure' : 'layers',
      expandedGroups: state.expandedGroups,
      expandedTypes: state.expandedTypes,
      collapsedSubtree: state.collapsedSubtree,
      maxNodes: 340,
    });
    if (state.hiddenEdgeKinds.size === 0) return composed;
    const edges = composed.edges.filter((edge) => !state.hiddenEdgeKinds.has(edge.kind));
    return { ...composed, edges };
  }, [session, state.nav, state.expandedGroups, state.expandedTypes, state.collapsedSubtree, state.hiddenEdgeKinds]);

  if (!session) return null;

  const showInspector = state.nav === 'overview' || state.nav === 'structure' || state.nav === 'dependencies' || state.nav === 'impact';

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-main">
        <NavRail />

        {state.nav === 'settings' ? (
          <section className="stage">
            <SettingsView />
          </section>
        ) : state.nav === 'ai' ? (
          <section className="stage">
            <div className={`ai-layout ${state.aiMapOpen ? '' : 'no-map'}`}>
              <AiPanel />
              {state.aiMapOpen && (
                <div className="ai-map">
                  <GraphCanvas
                    session={session}
                    view={view}
                    selectedNodeId={state.selectedNodeId}
                    highlighted={state.highlighted}
                    onSelect={selectNode}
                    onHover={hoverNode}
                    onExpand={toggleExpand}
                    compact
                  />
                </div>
              )}
            </div>
          </section>
        ) : (
          <>
            <section className="stage">
              <StageHead view={view} />
              <div className="stage-body">
                <GraphCanvas
                  session={session}
                  view={view}
                  selectedNodeId={state.selectedNodeId}
                  highlighted={state.highlighted}
                  onSelect={selectNode}
                  onHover={hoverNode}
                  onExpand={toggleExpand}
                />
                {state.nav === 'impact' && !state.selectedNodeId && (
                  <div className="graph-note" style={{ left: '50%', transform: 'translateX(-50%)', bottom: '50%', maxWidth: 380 }}>
                    Select a component on the map to see what depends on it.
                  </div>
                )}
              </div>
            </section>
            {showInspector && (
              <aside className={`inspector ${state.inspectorOpen ? '' : 'closed'}`}>
                {state.nav === 'overview' && <OverviewPanel />}
                {state.nav === 'structure' && <StructurePanel />}
                {state.nav === 'dependencies' && <DependenciesPanel />}
                {state.nav === 'impact' && <ImpactPanel />}
              </aside>
            )}
          </>
        )}
      </div>
      <NodeDetails />
    </div>
  );
}

function StageHead({ view }: { view: GraphView }) {
  const state = useAppState();
  const titles: Record<string, string> = {
    overview: 'Codebase map',
    structure: 'Structure',
    dependencies: 'Dependencies',
    impact: 'Impact',
  };

  const subtitles: Record<string, string> = {
    overview:
      'Projects and their layers, open by default. Click the +/− on a box to hide or reveal everything under it; double-click a type to open its members and dependencies.',
    structure: 'Folder tree. Click the +/− on a folder to reveal or hide everything inside it.',
    dependencies: 'Type-level relationships. Hover an edge colour in the legend to toggle a relationship type.',
    impact: state.selectedNodeId
      ? 'Potentially affected components are highlighted.'
      : 'Select a component to analyse what depends on it.',
  };

  return (
    <div className="stage-head">
      <span className="stage-title">{titles[state.nav] ?? 'Map'}</span>
      <span className="stage-sub nowrap" style={{ maxWidth: '38ch', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {subtitles[state.nav]}
      </span>

      <div className="spacer" />

      {state.highlightReason && (
        <span className="row" style={{ gap: 6 }}>
          <span className="tag accent">{state.highlightReason}</span>
          <button type="button" className="btn ghost sm" onClick={clearHighlight}>
            clear
          </button>
        </span>
      )}

      {state.nav === 'overview' && (
        <span className="row" style={{ gap: 5 }}>
          <button type="button" className="btn ghost sm" onClick={expandAllLayers}>
            Show all layers
          </button>
          <button type="button" className="btn ghost sm" onClick={collapseAll}>
            Collapse
          </button>
        </span>
      )}

      <button
        type="button"
        className="btn ghost sm"
        onClick={toggleInspector}
        title={state.inspectorOpen ? 'Hide the panel' : 'Show the panel'}
      >
        {state.inspectorOpen ? 'Panel ▸' : '◂ Panel'}
      </button>

      <GraphLegend kinds={view.kinds} edgeKinds={view.edgeKinds} />
    </div>
  );
}
