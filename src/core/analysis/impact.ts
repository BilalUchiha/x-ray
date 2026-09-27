import type { AnalysisSession, CodeGraph, CodeNode, EdgeKind, NodeKind } from '../types';

/** Edge kinds that represent a real dependency (structural containment excluded). */
const SEMANTIC_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'references', 'calls', 'inherits', 'implements', 'instantiates', 'depends_on',
]);

const MEMBER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'method', 'function', 'constructor', 'property', 'field',
]);

export interface ImpactMember {
  nodeId: string;
  name: string;
  kind: NodeKind;
  qualifiedName?: string;
  filePath?: string;
  /** Hop distance from the selected node (1 = direct). */
  distance: number;
}

export interface ImpactResult {
  nodeId: string;
  /** Outgoing dependencies of the selected node. */
  dependencies: ImpactMember[];
  /** Incoming dependents, one hop away. */
  dependents: ImpactMember[];
  /** Dependents reachable in two or more hops. */
  indirect: ImpactMember[];
  depthUsed: number;
}

export interface ImpactOptions {
  /** 1, 2, 3, or Number.POSITIVE_INFINITY for "all". */
  depth: number;
}

/**
 * Static dependency impact.
 *
 * The UI deliberately says "directly / indirectly dependent" and "potentially
 * affected": static analysis cannot know runtime behaviour (reflection,
 * dependency-injection wiring, dynamic dispatch, configuration, callers that
 * live outside the analysed folder).
 */
export function computeImpact(session: AnalysisSession, nodeId: string, options: ImpactOptions): ImpactResult {
  const { graph } = session.analysis;
  const nodeById = session.index.nodeById;
  const owner = buildOwnerMap(graph);
  const { outgoing, incoming } = buildAdjacency(graph);

  const scope = scopeOf(session, nodeId);
  const maxDepth = options.depth;

  const dependencies = traverse(outgoing, scope, owner, nodeById, 1, Number.MAX_SAFE_INTEGER, nodeId);
  const allDependents = traverse(incoming, scope, owner, nodeById, 1, maxDepth, nodeId);
  const dependents = allDependents.filter((m) => m.distance === 1);
  const indirect = allDependents.filter((m) => m.distance > 1);

  return {
    nodeId,
    dependencies: dependencies.filter((m) => !scope.has(m.nodeId)),
    dependents,
    indirect,
    depthUsed: maxDepth,
  };
}

/**
 * The set of node ids that "are" the selected component for impact purposes:
 * the node itself plus its members (or, for a member, its owner and siblings).
 */
function scopeOf(session: AnalysisSession, nodeId: string): Set<string> {
  const scope = new Set<string>([nodeId]);
  const node = session.index.nodeById.get(nodeId);
  if (!node) return scope;

  if (MEMBER_KINDS.has(node.kind) && node.parentId) {
    scope.add(node.parentId);
    for (const sibling of session.index.childrenOf.get(node.parentId) ?? []) scope.add(sibling);
  }
  for (const child of session.index.childrenOf.get(nodeId) ?? []) scope.add(child);
  return scope;
}

function buildOwnerMap(graph: CodeGraph): Map<string, string> {
  const owner = new Map<string, string>();
  for (const node of graph.nodes) {
    if (MEMBER_KINDS.has(node.kind) && node.parentId) owner.set(node.id, node.parentId);
    else owner.set(node.id, node.id);
  }
  return owner;
}

function buildAdjacency(graph: CodeGraph): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.derived || !SEMANTIC_KINDS.has(edge.kind)) continue;
    push(outgoing, edge.source, edge.target);
    push(incoming, edge.target, edge.source);
  }
  return { outgoing, incoming };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/**
 * Breadth-first traversal outward from `scope`, resolving reached nodes to the
 * entity that owns them (so a call into one method is reported against the
 * owning class), and skipping anything inside the origin scope.
 */
function traverse(
  adjacency: Map<string, string[]>,
  scope: Set<string>,
  owner: Map<string, string>,
  nodeById: Map<string, CodeNode>,
  minDistance: number,
  maxDistance: number,
  originId: string,
): ImpactMember[] {
  const visited = new Set<string>(scope);
  const bestDistance = new Map<string, number>();
  let frontier: string[] = [];

  for (const start of scope) {
    for (const next of adjacency.get(start) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      frontier.push(next);
    }
  }

  let distance = 1;
  const guardLimit = 20000;
  while (frontier.length > 0 && distance <= maxDistance && visited.size < guardLimit) {
    const next: string[] = [];
    for (const id of frontier) {
      const entity = owner.get(id) ?? id;
      if (entity !== originId && !scope.has(entity)) {
        const existing = bestDistance.get(entity);
        if (existing === undefined || distance < existing) {
          if (distance >= minDistance) bestDistance.set(entity, distance);
        }
      }
      for (const neighbour of adjacency.get(id) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
    distance++;
  }

  const results: ImpactMember[] = [];
  for (const [id, dist] of bestDistance) {
    const node = nodeById.get(id);
    if (!node) continue;
    results.push({
      nodeId: id,
      name: node.name,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      distance: dist,
    });
  }
  results.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return results;
}

/** Returns the semantic dependency edges that touch a node (for edge listing). */
export function edgesFor(session: AnalysisSession, nodeId: string): CodeGraph['edges'] {
  return session.analysis.graph.edges.filter(
    (edge) => !edge.derived && !edge.derived && (edge.source === nodeId || edge.target === nodeId) && SEMANTIC_KINDS.has(edge.kind),
  );
}
