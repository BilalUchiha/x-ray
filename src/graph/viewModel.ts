// View composition for the code map.
//
// The map never renders the whole graph at once. It renders the repository's
// real skeleton — projects and the architectural layers inside each of them —
// and reveals detail as the developer drills in. Layers are always scoped to a
// single app, so a monorepo's frontend and backend never share a bucket.

import type { Analysis, AnalysisSession, ArchGroup, CodeNode, EdgeKind, NodeKind } from '../core/types';
import { isTypeKind } from '../core/graph/build';

export interface ViewNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Group nodes aggregate their members and are drawn differently. */
  isGroup: boolean;
  memberCount: number;
  /** Connections within the currently visible view — drives node size. */
  degree: number;
  qualifiedName?: string;
  filePath?: string;
  namespace?: string;
  language?: string;
  color?: string;
  /** Small secondary line, e.g. the manifest that proved an app exists. */
  detail?: string;
  /** True when the node was added as a neighbour of an expanded node. */
  neighbour?: boolean;
  /** True when the node itself is an expanded group. */
  expanded?: boolean;
  /** App path the node belongs to, for inspection and grouping. */
  appId?: string;
  /** The layer this type was assigned to, if any. */
  layerLabel?: string;
  /**
   * How many boxes hang directly under this one — counted before any collapse,
   * so a folded box still advertises what it is hiding.
   */
  childCount?: number;
  /** True while this box's whole subtree is hidden by a collapse. */
  collapsed?: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  /** True when the edge aggregates several relationships. */
  aggregated?: boolean;
  /** Structural edges (containment) are excluded from node degree. */
  derived?: boolean;
}

export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Node kinds actually present, for the legend. */
  kinds: NodeKind[];
  edgeKinds: EdgeKind[];
  hiddenNodes: number;
  totalNodes: number;
}

export interface ComposeOptions {
  /** 'layers' explores architecture; 'structure' explores the folder tree. */
  mode?: 'layers' | 'structure';
  expandedGroups: Set<string>;
  expandedTypes: Set<string>;
  /** Boxes the user folded shut; everything beneath them is left out. */
  collapsedSubtree?: Set<string>;
  maxNodes?: number;
}

const GROUP_PALETTE = [
  '#4dd0c7', '#4da3ff', '#a78bfa', '#f59e0b', '#34d399',
  '#f472b6', '#22d3ee', '#fb923c', '#818cf8', '#a3e635',
];

const SEMANTIC: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'references', 'calls', 'inherits', 'implements', 'instantiates', 'depends_on',
]);

const DEFAULT_MAX_NODES = 340;
const MIN_MEMBERS_PER_GROUP = 3;
const MAX_MEMBERS_PER_GROUP = 40;

export const PROJECT_ID = 'project';

/** Id of the structural node for a scope (a project or a grouping folder). */
export function scopeNodeId(path: string): string {
  return `scope:${path}`;
}

/**
 * Which groups are open when a workspace is first analysed: all of them, as
 * long as that produces a map a person can actually read. Every layer keeps its
 * most connected types (see the per-group budget in composeGraphView), so a
 * large codebase still shows its full skeleton instead of a nearly empty page.
 */
export function defaultExpandedGroups(analysis: Analysis): Set<string> {
  return new Set(analysis.groups.filter((group) => group.memberIds.length > 0).map((group) => group.id));
}

export function composeGraphView(session: AnalysisSession, options: ComposeOptions): GraphView {
  if (options.mode === 'structure') return composeStructure(session, options);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const { analysis, index } = session;
  const scopes = analysis.scopes ?? [];

  const groups = analysis.groups.filter((group) => group.memberIds.length > 0);
  const groupById = new Map(groups.map((group, i) => [group.id, { ...group, color: GROUP_PALETTE[i % GROUP_PALETTE.length] }]));
  const groupOfType = new Map<string, string>();
  for (const group of groups) for (const memberId of group.memberIds) groupOfType.set(memberId, group.id);

  const globalDegree = computeDegree(analysis);

  // --- structural nodes: projects and the folders that group them ---------
  const containers = new Map<string, ViewNode>();
  scopes.forEach((scope, i) => {
    containers.set(scopeNodeId(scope.path), {
      id: scopeNodeId(scope.path),
      label: scope.name,
      kind: scope.nodeKind === 'app' ? 'app' : 'workspace',
      isGroup: true,
      memberCount: 0,
      degree: 0,
      color: GROUP_PALETTE[(i + 1) % GROUP_PALETTE.length],
      detail: scope.marker ?? 'no build file',
      expanded: true,
      filePath: scope.path,
      appId: scope.path,
    });
  });

  /** The node a group hangs from: its scope, else the project. */
  const containerForApp = (appId: string): string => (appId ? scopeNodeId(appId) : PROJECT_ID);

  const nodes = new Map<string, ViewNode>();
  const edges = new Map<string, ViewEdge>();

  // Children a box can reveal even when they are not in the view right now:
  // a folded layer still says how many types it holds, and a type still says
  // whether drilling into it is worth anything.
  const childCounts = new Map<string, number>();
  const noteChildren = (id: string, count: number): void => {
    if (count > 0) childCounts.set(id, count);
  };

  const addNode = (node: ViewNode): ViewNode => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id)!;
  };

  const addEdge = (source: string, target: string, kind: EdgeKind, weight = 1, aggregated = false, derived = false) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = `${source}|${target}|${kind}`;
    const existing = edges.get(key);
    if (existing) {
      existing.weight += weight;
      return;
    }
    edges.set(key, { id: `ve:${edges.size}`, source, target, kind, weight, aggregated, derived });
  };

  // --- 1. Anchor: project, workspaces, apps -------------------------------
  addNode({
    id: PROJECT_ID,
    label: analysis.name,
    kind: 'project',
    isGroup: false,
    memberCount: analysis.stats.classes + analysis.stats.interfaces,
    degree: 0,
  });

  for (const node of containers.values()) addNode(node);
  for (const scope of scopes) {
    const parent = scope.parentPath ? scopeNodeId(scope.parentPath) : PROJECT_ID;
    addEdge(parent, scopeNodeId(scope.path), 'contains', 1, true, true);
  }

  // --- 2. Layer groups, always visible, attached to their app -------------
  for (const group of groupById.values()) {
    addNode({
      id: group.id,
      label: group.label,
      kind: 'folder',
      isGroup: true,
      memberCount: group.memberIds.length,
      degree: 0,
      color: group.color,
      expanded: options.expandedGroups.has(group.id),
      appId: group.appId,
      detail: group.appId ? undefined : group.description,
    });
    noteChildren(group.id, group.memberIds.length);
    addEdge(containerForApp(group.appId), group.id, 'contains', 1, true, true);
  }

  // Container member counts: how many types live inside each project, counted
  // up the ancestor chain so a grouping folder shows its whole subtree.
  const scopeByPath = new Map(scopes.map((scope) => [scope.path, scope]));
  for (const group of groupById.values()) {
    let path: string | undefined = group.appId || undefined;
    const seen = new Set<string>();
    while (path && !seen.has(path)) {
      seen.add(path);
      const node = containers.get(scopeNodeId(path));
      if (node) node.memberCount += group.memberIds.length;
      path = scopeByPath.get(path)?.parentPath || undefined;
    }
  }

  // --- 3. Types inside expanded groups, within a per-layer budget ---------
  const containerCount = containers.size + 1;
  const groupCount = Math.max(1, groupById.size);
  const budget = Math.max(
    MIN_MEMBERS_PER_GROUP,
    Math.min(
      MAX_MEMBERS_PER_GROUP,
      Math.floor(Math.max(0, maxNodes - containerCount - groupCount) / groupCount),
    ),
  );

  const neighbours = new Map<string, Set<string>>();
  const memberRank = (id: string, name: string) => ({ id, name, weight: globalDegree.get(id) ?? 0 });

  for (const groupId of options.expandedGroups) {
    const group = groupById.get(groupId);
    if (!group) continue;
    const members = group.memberIds
      .map((memberId) => {
        const node = index.nodeById.get(memberId);
        return node ? memberRank(memberId, node.name) : null;
      })
      .filter((entry): entry is { id: string; name: string; weight: number } => entry !== null)
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
      .slice(0, budget);

    for (const member of members) {
      const node = index.nodeById.get(member.id);
      if (!node) continue;
      addNode({ ...toViewNode(node), layerLabel: group.label });
      noteChildren(member.id, index.childrenOf.get(member.id)?.length ?? 0);
      addEdge(groupId, member.id, 'contains', 1, true, true);
    }
  }

  // --- 4. Drilled-in types: members + direct neighbours -------------------
  for (const typeId of options.expandedTypes) {
    const type = index.nodeById.get(typeId);
    if (!type) continue;
    addNode({ ...toViewNode(type), layerLabel: groupLabelOf(groupOfType, groupById, typeId) });
    noteChildren(typeId, index.childrenOf.get(typeId)?.length ?? 0);
    const groupId = groupOfType.get(typeId);
    if (groupId) addEdge(groupId, typeId, 'contains', 1, true, true);

    for (const memberId of index.childrenOf.get(typeId) ?? []) {
      const member = index.nodeById.get(memberId);
      if (!member) continue;
      if (member.kind !== 'method' && member.kind !== 'constructor' && member.kind !== 'function' && member.kind !== 'property') continue;
      addNode(toViewNode(member));
      addEdge(typeId, memberId, 'contains', 1, true, true);
    }

    for (const neighbourId of semanticNeighbours(session, typeId)) {
      const neighbour = index.nodeById.get(neighbourId);
      if (!neighbour) continue;
      const viewNode = toViewNode(neighbour);
      viewNode.neighbour = true;
      addNode(viewNode);
      noteChildren(neighbourId, index.childrenOf.get(neighbourId)?.length ?? 0);
      // Hang a revealed neighbour under its own layer, so it keeps a place in
      // the chart instead of floating loose at the edge of the map.
      const groupId = groupOfType.get(neighbourId);
      if (groupId) addEdge(groupId, neighbourId, 'contains', 1, true, true);
      markNeighbour(neighbours, typeId, neighbourId);
    }
  }

  // --- 5. Real edges between visible nodes --------------------------------
  const visible = new Set(nodes.keys());
  for (const edge of analysis.graph.edges) {
    if (edge.kind === 'contains' || edge.derived) continue;
    if (!SEMANTIC.has(edge.kind) && edge.kind !== 'imports') continue;
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    addEdge(edge.source, edge.target, edge.kind, edge.weight);
  }

  // --- 6. Fold hidden members' relationships into their layer -------------
  for (const edge of analysis.graph.edges) {
    if (edge.derived || edge.kind === 'contains' || !SEMANTIC.has(edge.kind)) continue;
    if (visible.has(edge.source) && visible.has(edge.target)) continue; // already drawn
    const sourceGroup = visible.has(edge.source) ? null : groupOfType.get(edge.source) ?? null;
    const targetGroup = visible.has(edge.target) ? null : groupOfType.get(edge.target) ?? null;
    if (!sourceGroup || !targetGroup) continue;
    addEdge(sourceGroup, targetGroup, edge.kind, edge.weight, true);
  }

  // --- 7. Neighbour edges: keep the drill-in readable --------------------
  for (const [typeId, set] of neighbours) {
    for (const other of set) {
      for (const edge of analysis.graph.edges) {
        if (edge.derived || !SEMANTIC.has(edge.kind)) continue;
        if ((edge.source === typeId && edge.target === other) || (edge.target === typeId && edge.source === other)) {
          addEdge(edge.source, edge.target, edge.kind, edge.weight);
        }
      }
    }
  }

  // Containers are open by default; layers and types start closed, so a box is
  // "open" exactly when its children were just built.
  const openIds = new Set<string>([PROJECT_ID, ...containers.keys(), ...options.expandedGroups, ...options.expandedTypes]);
  applyCollapse(nodes, edges, options.collapsedSubtree ?? new Set(), childCounts, openIds);
  return finalize(nodes, edges, globalDegree, index, maxNodes);
}

/**
 * Hides the whole subtree under every folded box.
 *
 * Collapsing is a view operation only: the analysis is untouched, and because
 * the open/closed state of layers and types is stored separately, unfolding a
 * container brings back exactly the boxes that were there before. The folded
 * box itself stays visible — it is the handle you click to open it again — and
 * keeps a `childCount` so the canvas can show what is hidden.
 */
function applyCollapse(
  nodes: Map<string, ViewNode>,
  edges: Map<string, ViewEdge>,
  collapsed: Set<string>,
  childCounts: Map<string, number>,
  openIds: Set<string>,
): void {
  const fromEdges = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (edge.kind !== 'contains') continue;
    fromEdges.set(edge.source, (fromEdges.get(edge.source) ?? 0) + 1);
    const list = childrenOf.get(edge.source) ?? [];
    list.push(edge.target);
    childrenOf.set(edge.source, list);
  }

  for (const node of nodes.values()) {
    const count = Math.max(fromEdges.get(node.id) ?? 0, childCounts.get(node.id) ?? 0);
    if (count === 0) continue;
    node.childCount = count;
    // The disclosure control has to tell the truth: a box whose children are on
    // screen shows "−", one that is hiding them shows "+".
    if (collapsed.has(node.id) || !openIds.has(node.id)) node.collapsed = true;
  }

  if (collapsed.size === 0) return;

  const hidden = new Set<string>();
  const queue: string[] = [];
  for (const id of collapsed) {
    const node = nodes.get(id);
    if (!node) continue;
    node.collapsed = true;
    queue.push(...(childrenOf.get(id) ?? []));
  }
  // Breadth-first over containment; the `hidden` set also terminates cycles.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (hidden.has(id)) continue;
    hidden.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }

  for (const id of hidden) nodes.delete(id);
  for (const [key, edge] of edges) {
    if (hidden.has(edge.source) || hidden.has(edge.target)) edges.delete(key);
  }
}

/**
 * Shared tail: degree computation plus degree-ranked trimming that always keeps
 * the structural nodes (project, workspaces, apps, layers).
 */
function finalize(
  nodes: Map<string, ViewNode>,
  edges: Map<string, ViewEdge>,
  globalDegree: Map<string, number>,
  index: AnalysisSession['index'],
  maxNodes: number,
): GraphView {
  const degree = new Map<string, number>();
  for (const edge of edges.values()) {
    if (edge.derived && edge.kind === 'contains') continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  let nodeList = Array.from(nodes.values());
  const totalNodes = nodeList.length;
  let hiddenNodes = 0;

  if (nodeList.length > maxNodes) {
    const structural = nodeList.filter((node) => node.isGroup || node.id === PROJECT_ID);
    const rest = nodeList
      .filter((node) => !node.isGroup && node.id !== PROJECT_ID)
      .sort((a, b) => {
        const da = globalDegree.get(a.id) ?? 0;
        const db = globalDegree.get(b.id) ?? 0;
        return db - da || a.label.localeCompare(b.label);
      })
      .slice(0, Math.max(0, maxNodes - structural.length));
    const kept = new Set([...structural, ...rest].map((node) => node.id));
    hiddenNodes = totalNodes - kept.size;
    nodeList = nodeList.filter((node) => kept.has(node.id));
  }

  const keptIds = new Set(nodeList.map((node) => node.id));
  const edgeList = Array.from(edges.values()).filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));

  for (const node of nodeList) {
    node.degree = degree.get(node.id) ?? 0;
    if (node.qualifiedName === undefined) {
      const real = index.nodeById.get(node.id);
      if (real) node.qualifiedName = real.qualifiedName;
    }
  }

  return {
    nodes: nodeList,
    edges: edgeList,
    kinds: Array.from(new Set(nodeList.map((node) => node.kind))),
    edgeKinds: Array.from(new Set(edgeList.map((edge) => edge.kind))),
    hiddenNodes,
    totalNodes,
  };
}

function groupLabelOf(groupOfType: Map<string, string>, groupById: Map<string, ArchGroup>, nodeId: string): string | undefined {
  const groupId = groupOfType.get(nodeId);
  return groupId ? groupById.get(groupId)?.label : undefined;
}

function computeDegree(analysis: Analysis): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of analysis.graph.edges) {
    if (edge.derived || edge.kind === 'contains') continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

/**
 * Folder-tree view: the top level is always visible, and opening a directory
 * reveals what is inside it — its files and its subdirectories. Even a large
 * repository therefore reads as a tree you walk down, not a wall of folders.
 */
function composeStructure(session: AnalysisSession, options: ComposeOptions): GraphView {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const { analysis, index } = session;
  const nodes = new Map<string, ViewNode>();
  const edges = new Map<string, ViewEdge>();

  const addNode = (node: ViewNode): ViewNode => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id)!;
  };
  const addEdge = (source: string, target: string, kind: EdgeKind) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = `${source}|${target}|${kind}`;
    if (!edges.has(key)) edges.set(key, { id: `se:${edges.size}`, source, target, kind, weight: 1, derived: true });
  };

  addNode({
    id: PROJECT_ID,
    label: analysis.name,
    kind: 'project',
    isGroup: false,
    memberCount: analysis.stats.folders,
    degree: 0,
  });

  let paletteIndex = 0;
  const childCounts = new Map<string, number>();
  const folders = analysis.graph.nodes.filter((node) => node.kind === 'folder');
  const roots = folders
    .filter((folder) => folder.parentId === PROJECT_ID)
    .sort((a, b) => a.name.localeCompare(b.name));

  // The folder tree mirrors the inspector's disclosure: a directory is drawn
  // once its parent is open, and its files appear when the directory itself is
  // open. Folding a folder therefore hides its whole subtree instead of leaving
  // its grandchildren stranded on the map.
  const queue = roots.map((folder) => ({ folder, parentId: PROJECT_ID }));
  for (let i = 0; i < queue.length; i++) {
    const { folder, parentId } = queue[i];
    const children = index.childrenOf.get(folder.id) ?? [];
    const isExpanded = options.expandedGroups.has(folder.id);
    addNode({
      id: folder.id,
      label: folder.name,
      kind: 'folder',
      isGroup: true,
      memberCount: children.length,
      degree: 0,
      color: GROUP_PALETTE[paletteIndex++ % GROUP_PALETTE.length],
      expanded: isExpanded,
      filePath: folder.filePath,
    });
    childCounts.set(folder.id, children.length);
    addEdge(parentId, folder.id, 'contains');
    if (!isExpanded) continue;

    for (const childId of children) {
      const child = index.nodeById.get(childId);
      if (!child) continue;
      if (child.kind === 'folder') {
        queue.push({ folder: child, parentId: folder.id });
        continue;
      }
      if (child.kind !== 'file') continue;
      addNode({
        id: child.id,
        label: child.name,
        kind: 'file',
        isGroup: false,
        memberCount: 0,
        degree: 0,
        filePath: child.filePath,
        language: child.language,
      });
      addEdge(folder.id, child.id, 'contains');
    }
  }

  const openIds = new Set<string>([PROJECT_ID, ...options.expandedGroups]);
  applyCollapse(nodes, edges, options.collapsedSubtree ?? new Set(), childCounts, openIds);

  const degree = new Map<string, number>();
  for (const edge of edges.values()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  let nodeList = Array.from(nodes.values());
  const totalNodes = nodeList.length;
  let hiddenNodes = 0;
  if (nodeList.length > maxNodes) {
    const core = nodeList.filter((node) => node.id === PROJECT_ID || node.isGroup);
    const rest = nodeList.filter((node) => !node.isGroup && node.id !== PROJECT_ID).slice(0, Math.max(0, maxNodes - core.length));
    const kept = new Set([...core, ...rest].map((node) => node.id));
    hiddenNodes = totalNodes - kept.size;
    nodeList = nodeList.filter((node) => kept.has(node.id));
  }

  const keptIds = new Set(nodeList.map((node) => node.id));
  const edgeList = Array.from(edges.values()).filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));
  for (const node of nodeList) node.degree = degree.get(node.id) ?? 0;

  return {
    nodes: nodeList,
    edges: edgeList,
    kinds: Array.from(new Set(nodeList.map((node) => node.kind))),
    edgeKinds: Array.from(new Set(edgeList.map((edge) => edge.kind))),
    hiddenNodes,
    totalNodes,
  };
}

function toViewNode(node: CodeNode): ViewNode {
  return {
    id: node.id,
    label: node.name,
    kind: node.kind,
    isGroup: false,
    memberCount: node.memberCount ?? 0,
    degree: 0,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    namespace: node.namespace,
    language: node.language,
  };
}

function markNeighbour(map: Map<string, Set<string>>, a: string, b: string): void {
  const set = map.get(a) ?? new Set<string>();
  set.add(b);
  map.set(a, set);
}

function semanticNeighbours(session: AnalysisSession, typeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of session.analysis.graph.edges) {
    if (edge.derived || !SEMANTIC.has(edge.kind)) continue;
    let other: string | null = null;
    if (edge.source === typeId) other = edge.target;
    else if (edge.target === typeId) other = edge.source;
    if (!other) continue;
    const node = session.index.nodeById.get(other);
    if (!node) continue;
    if (!isTypeKind(node.kind)) continue;
    if (seen.has(other)) continue;
    seen.add(other);
    out.push(other);
    if (out.length >= 12) break;
  }
  return out;
}
