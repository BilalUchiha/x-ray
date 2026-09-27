import { analyzeFolder, buildIndex, type AnalysisProgress } from '../core/analysis/analyze';
import { computeImpact } from '../core/analysis/impact';
import { searchCodebase } from '../core/search/search';
import { folderFromManifest, pickFolder, supportsDirectoryPicker, type FolderSource } from '../core/fs/source';
import { askCodebase, type ChatTurn } from '../core/ai/chat';
import { testConnection as probeConnection } from '../core/ai/client';
import {
  activeProvider,
  createProvider,
  isConfigured,
  loadAiSettings,
  saveAiSettings,
  type AiProviderConfig,
  type AiSettings,
  type ProviderKind,
} from '../core/settings/aiSettings';
import {
  clearWorkspaces,
  deleteWorkspace,
  listWorkspaces,
  loadAnalysis,
  saveWorkspace,
} from '../core/storage/workspaces';
import { SAMPLE_PROJECT_FILES, SAMPLE_PROJECT_NAME } from '../sample/manifest';
import { defaultExpandedGroups, PROJECT_ID, scopeNodeId } from '../graph/viewModel';
import { isTypeKind } from '../core/graph/build';
import { store, toast, type AppState, type NavSection } from './store';
import type { AnalysisSession } from '../core/types';

const PHASE_ORDER: AnalysisProgress['phase'][] = [
  'scanning', 'languages', 'parsing', 'symbols', 'dependencies', 'graph',
];

let currentSource: FolderSource | null = null;
let abortController: AbortController | null = null;
let askController: AbortController | null = null;

// --- boot ------------------------------------------------------------------

export async function initApp(): Promise<void> {
  const [aiSettings, workspaces] = await Promise.all([
    loadAiSettings().catch(() => ({ providers: [], activeProviderId: null })),
    listWorkspaces().catch(() => []),
  ]);
  store.set({ aiSettings, workspaces });
}

// --- folder selection + analysis -------------------------------------------

export function canPickFolder(): boolean {
  return supportsDirectoryPicker();
}

export async function chooseFolder(): Promise<void> {
  try {
    const source = await pickFolder();
    if (!source) return;
    await analyzeSource(source);
  } catch (err) {
    store.set({ analysisError: describe(err) });
    toast('Could not open that folder.');
  }
}

export function openSampleProject(): Promise<void> {
  return analyzeSource(folderFromManifest(SAMPLE_PROJECT_NAME, SAMPLE_PROJECT_FILES));
}

export async function analyzeSource(source: FolderSource): Promise<void> {
  abortController?.abort();
  abortController = new AbortController();
  currentSource = source;

  store.set({
    screen: 'analyzing',
    folderName: source.name,
    progress: null,
    completedPhases: [],
    analysisError: null,
    selectedNodeId: null,
    highlighted: new Set<string>(),
    highlightReason: null,
    impact: null,
    searchQuery: '',
    searchResults: [],
    expandedGroups: new Set<string>(),
    expandedTypes: new Set<string>(),
    collapsedSubtree: new Set<string>(),
    aiContext: null,
    streamBuffer: '',
  });

  try {
    const session = await analyzeFolder(
      source,
      (progress) => {
        const completed = new Set(store.get().completedPhases);
        const index = PHASE_ORDER.indexOf(progress.phase);
        for (let i = 0; i < index; i++) completed.add(PHASE_ORDER[i]);
        completed.add(progress.phase);
        store.set({ progress, completedPhases: Array.from(completed) });
      },
      abortController.signal,
    );

    store.set({
      screen: 'dashboard',
      session,
      sourceAvailable: true,
      nav: 'overview',
      // Open every architectural layer: the first thing a person sees should be
      // the codebase's real contents, not a page of collapsed placeholders.
      expandedGroups: defaultExpandedGroups(session.analysis),
      progress: null,
      analysisError: null,
    });

    await saveWorkspace(session).catch(() => undefined);
    void refreshWorkspaces();
    toast(`Analysed ${session.analysis.stats.totalFiles.toLocaleString()} files from ${session.analysis.name}.`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      store.set({ screen: 'welcome', progress: null, completedPhases: [] });
      return;
    }
    store.set({ screen: 'welcome', analysisError: describe(err), progress: null });
  } finally {
    abortController = null;
  }
}

export function cancelAnalysis(): void {
  abortController?.abort();
}

export function rescan(): void {
  if (!currentSource) {
    toast('Re-select the folder to rescan — the browser cannot silently reopen it.');
    return;
  }
  void analyzeSource(currentSource);
}

export function canRescan(): boolean {
  return currentSource !== null;
}

// --- navigation + selection ------------------------------------------------

export function setNav(nav: NavSection): void {
  const state = store.get();
  const patch: Parameters<typeof store.set>[0] = { nav };

  if (nav === 'dependencies' && state.session) {
    // The dependency view needs types on screen, not just layers — so every
    // folded container is opened rather than left showing an empty chart.
    patch.expandedGroups = new Set(state.session.analysis.groups.map((group) => group.id));
    patch.expandedTypes = new Set<string>();
    patch.collapsedSubtree = new Set<string>();
    patch.highlighted = new Set<string>();
    patch.highlightReason = null;
  }
  if (nav === 'overview') {
    patch.expandedTypes = new Set<string>();
    patch.highlighted = new Set<string>();
    patch.highlightReason = null;
  }
  if (nav === 'structure') {
    patch.expandedTypes = new Set<string>();
  }

  store.set(patch);
  if (nav === 'impact') recomputeImpact();
}

export function selectNode(nodeId: string | null): void {
  store.set({ selectedNodeId: nodeId });
  const state = store.get();
  if (state.nav === 'impact') recomputeImpact();
  if (nodeId) revealSelected(nodeId);
}

/**
 * Anything picked by name — a search hit, an entry in the inspector, a
 * component cited by the AI — has to be visible, so its enclosing layer is
 * opened and every folded container above it is unfolded first. Otherwise the
 * map would highlight nothing and the answer would look broken.
 */
function revealSelected(nodeId: string): void {
  const state = store.get();
  const session = state.session;
  if (!session) return;

  const patch: Partial<AppState> = {};
  const groupId = session.index.nodeById.get(nodeId)?.groupId;
  if (groupId && !state.expandedGroups.has(groupId)) {
    patch.expandedGroups = new Set(state.expandedGroups).add(groupId);
  }

  const ancestors = containerAncestors(session, nodeId);
  if (ancestors.length > 0) {
    const collapsed = new Set(state.collapsedSubtree);
    let changed = false;
    for (const id of ancestors) if (collapsed.delete(id)) changed = true;
    if (changed) patch.collapsedSubtree = collapsed;
  }

  if (Object.keys(patch).length > 0) store.set(patch);
}

/** The project plus every scope above a node, innermost first. */
function containerAncestors(session: AnalysisSession, nodeId: string): string[] {
  const { analysis, index } = session;
  if (nodeId === PROJECT_ID) return [];

  const groupById = new Map(analysis.groups.map((group) => [group.id, group]));
  let appPath: string | undefined;
  if (nodeId.startsWith('scope:')) {
    appPath = nodeId.slice('scope:'.length);
  } else if (groupById.has(nodeId)) {
    appPath = groupById.get(nodeId)!.appId;
  } else {
    let current = index.nodeById.get(nodeId);
    let hops = 0;
    while (current && hops++ < 32) {
      if (current.groupId) {
        appPath = groupById.get(current.groupId)?.appId;
        break;
      }
      current = current.parentId ? index.nodeById.get(current.parentId) : undefined;
    }
  }

  const scopeByPath = new Map((analysis.scopes ?? []).map((scope) => [scope.path, scope]));
  const out = [PROJECT_ID];
  const seen = new Set<string>();
  let path = appPath;
  while (path && scopeByPath.has(path) && !seen.has(path)) {
    seen.add(path);
    out.push(scopeNodeId(path));
    path = scopeByPath.get(path)!.parentPath;
  }
  return out;
}

export function hoverNode(nodeId: string | null): void {
  if (store.get().hoveredNodeId === nodeId) return;
  store.set({ hoveredNodeId: nodeId });
}

/**
 * The one gesture behind every "+"/"−" on the map: hide or reveal everything
 * that sits under a box.
 *
 * What "under" means depends on the box, because different kinds of box start
 * in different states. Layers and folders start closed and are revealed by the
 * open sets; types start closed and reveal their members when opened; the
 * project, workspaces and apps are open by default, so folding one records it
 * in `collapsedSubtree`. From the outside all three read the same way: click
 * the control, the subtree goes away; click it again, it comes back.
 */
export function toggleExpand(nodeId: string): void {
  const state = store.get();
  const session = state.session;
  if (!session) return;

  if (session.analysis.groups.some((group) => group.id === nodeId)) {
    if (toggleInSet(state.expandedGroups, 'expandedGroups', nodeId)) revealSelected(nodeId);
    return;
  }

  const node = session.index.nodeById.get(nodeId);
  if (node?.kind === 'folder') {
    if (toggleInSet(state.expandedGroups, 'expandedGroups', nodeId)) revealSelected(nodeId);
    return;
  }

  // A type reveals its members and its direct neighbours.
  if (node && isTypeKind(node.kind)) {
    // Opening something that a fold is hiding would look like nothing happened,
    // so the containers above it are unfolded first.
    if (toggleInSet(state.expandedTypes, 'expandedTypes', nodeId)) revealSelected(nodeId);
    return;
  }

  // Everything left that can own a subtree in the map is a structural
  // container: the project itself, a workspace, or a project/app inside one.
  if (nodeId === PROJECT_ID || nodeId.startsWith('scope:')) toggleContainer(nodeId);
}

/** Folds or unfolds a structural container's whole subtree in the map. */
export function toggleContainer(nodeId: string): void {
  const state = store.get();
  const collapsed = new Set(state.collapsedSubtree);
  if (!collapsed.delete(nodeId)) collapsed.add(nodeId);
  store.set({ collapsedSubtree: collapsed });
}

/** Flips an id in an open-set. Returns true when that opened it. */
function toggleInSet(
  current: Set<string>,
  key: 'expandedGroups' | 'expandedTypes',
  id: string,
): boolean {
  const next = new Set(current);
  const opened = !next.delete(id);
  if (opened) next.add(id);
  store.set({ [key]: next } as Partial<AppState>);
  return opened;
}

/** Folds the whole chart down to the project box. */
export function collapseAll(): void {
  const state = store.get();
  store.set({
    collapsedSubtree: state.session ? new Set([PROJECT_ID]) : new Set<string>(),
    expandedTypes: new Set<string>(),
    highlighted: new Set<string>(),
    highlightReason: null,
  });
}

/** Unfolds everything and opens every layer — the map at full detail. */
export function expandAllLayers(): void {
  const state = store.get();
  if (!state.session) return;
  store.set({
    expandedGroups: new Set(state.session.analysis.groups.map((g) => g.id)),
    collapsedSubtree: new Set<string>(),
  });
}

// --- search ----------------------------------------------------------------

export function runSearch(query: string): void {
  const state = store.get();
  if (!state.session) {
    store.set({ searchQuery: query, searchResults: [] });
    return;
  }
  store.set({
    searchQuery: query,
    searchResults: query.trim().length >= 2 ? searchCodebase(state.session, query, { limit: 40 }) : [],
  });
}

export function clearSearch(): void {
  store.set({ searchQuery: '', searchResults: [] });
}

// --- impact ----------------------------------------------------------------

export function setImpactDepth(depth: number): void {
  store.set({ impactDepth: depth });
  recomputeImpact();
}

export function recomputeImpact(): void {
  const state = store.get();
  if (!state.session || !state.selectedNodeId) {
    store.set({ impact: null });
    return;
  }
  const depth = state.impactDepth === 0 ? Number.POSITIVE_INFINITY : state.impactDepth;
  const impact = computeImpact(state.session, state.selectedNodeId, { depth });
  store.set({ impact });
}

export function highlightImpact(): void {
  const state = store.get();
  if (!state.impact) return;
  const ids = new Set<string>([state.impact.nodeId]);
  for (const member of [...state.impact.dependents, ...state.impact.indirect]) ids.add(member.nodeId);
  store.set({
    highlighted: ids,
    highlightReason: `${ids.size - 1} potentially affected component${ids.size - 1 === 1 ? '' : 's'}`,
  });
}

export function highlightDependencies(): void {
  const state = store.get();
  if (!state.impact) return;
  const ids = new Set<string>([state.impact.nodeId]);
  for (const member of state.impact.dependencies) ids.add(member.nodeId);
  store.set({ highlighted: ids, highlightReason: `${ids.size - 1} direct dependenc${ids.size - 1 === 1 ? 'y' : 'ies'}` });
}

export function highlightNodes(nodeIds: string[], reason: string): void {
  store.set({ highlighted: new Set(nodeIds), highlightReason: reason });
}

export function clearHighlight(): void {
  store.set({ highlighted: new Set<string>(), highlightReason: null });
}

export function toggleWarnings(): void {
  const current = store.get() as AppState;
  store.set({ showWarnings: !current.showWarnings });
}

/** Opens the warnings list by routing to Settings, which owns that detail. */
export function openWarnings(): void {
  store.set({ nav: 'settings', showWarnings: true });
}

export function toggleInspector(): void {
  store.set({ inspectorOpen: !store.get().inspectorOpen });
}

/** Shows or hides the map beside the AI chat, so the transcript can have it all. */
export function toggleAiMap(): void {
  store.set({ aiMapOpen: !store.get().aiMapOpen });
}

export function toggleEdgeKind(kind: string): void {
  const state = store.get();
  const hidden = new Set(state.hiddenEdgeKinds);
  if (hidden.has(kind as never)) hidden.delete(kind as never);
  else hidden.add(kind as never);
  store.set({ hiddenEdgeKinds: hidden });
}

// --- workspaces ------------------------------------------------------------

export async function refreshWorkspaces(): Promise<void> {
  const workspaces = await listWorkspaces().catch(() => []);
  store.set({ workspaces });
}

export async function openStoredWorkspace(id: string): Promise<void> {
  const analysis = await loadAnalysis(id);
  if (!analysis) {
    toast('That saved analysis is no longer available.');
    return;
  }
  const index = buildIndex(analysis);
  const session: AnalysisSession = {
    analysis,
    index,
    fileById: new Map(),
    contents: new Map(),
    parsed: [],
  };
  currentSource = null;
  store.set({
    screen: 'dashboard',
    session,
    sourceAvailable: false,
    nav: 'overview',
    selectedNodeId: null,
    highlighted: new Set<string>(),
    highlightReason: null,
    impact: null,
    expandedGroups: defaultExpandedGroups(analysis),
    expandedTypes: new Set<string>(),
    collapsedSubtree: new Set<string>(),
    searchQuery: '',
    searchResults: [],
    aiContext: null,
    streamBuffer: '',
  });
  toast('Re-select the folder to use AI answers and rescanning.');
}

export async function removeWorkspace(id: string): Promise<void> {
  await deleteWorkspace(id);
  await refreshWorkspaces();
}

export async function clearStoredWorkspaces(): Promise<void> {
  await clearWorkspaces().catch(() => undefined);
  await refreshWorkspaces();
  toast('Stored analyses cleared.');
}

export function goHome(): void {
  abortController?.abort();
  askController?.abort();
  currentSource = null;
  store.reset();
  void refreshWorkspaces();
}

// --- AI --------------------------------------------------------------------

async function persistAi(settings: AiSettings): Promise<void> {
  store.set({ aiSettings: settings });
  await saveAiSettings(settings).catch(() => undefined);
}

export function addProvider(kind: ProviderKind): void {
  const state = store.get();
  const provider = createProvider(kind, state.aiSettings.providers);
  const providers = [...state.aiSettings.providers, provider];
  void persistAi({ providers, activeProviderId: state.aiSettings.activeProviderId ?? provider.id });
  toast(`${provider.label} added — enter your API key.`);
}

export function updateProvider(id: string, patch: Partial<AiProviderConfig>): void {
  const state = store.get();
  const providers = state.aiSettings.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider));
  void persistAi({ ...state.aiSettings, providers });
}

export function removeProvider(id: string): void {
  const state = store.get();
  const providers = state.aiSettings.providers.filter((provider) => provider.id !== id);
  const activeProviderId = state.aiSettings.activeProviderId === id ? (providers[0]?.id ?? null) : state.aiSettings.activeProviderId;
  void persistAi({ providers, activeProviderId });
  store.set({ connectionTest: null });
}

export function activateProvider(id: string): void {
  const state = store.get();
  void persistAi({ ...state.aiSettings, activeProviderId: id });
  store.set({ connectionTest: null });
}

export async function runConnectionTest(): Promise<void> {
  const provider = activeProvider(store.get().aiSettings);
  if (!provider) return;
  store.set({ testingConnection: true, connectionTest: null });
  const result = await probeConnection(provider);
  store.set({ testingConnection: false, connectionTest: result });
}

export function setAiError(message: string | null): void {
  store.set({ aiError: message });
}

export function clearChat(): void {
  store.set({ chat: [], aiContext: null, aiError: null, streamBuffer: '' });
}

export function cancelAsk(): void {
  askController?.abort();
  askController = null;
}

export async function ask(question: string): Promise<void> {
  const state = store.get();
  const { session } = state;
  if (!session) return;

  if (!state.sourceAvailable) {
    store.set({ aiError: 'Source code is not loaded. Re-select the folder first — saved analyses store structure only.' });
    return;
  }

  const provider = activeProvider(state.aiSettings);
  if (!provider) {
    store.set({ aiError: 'No AI provider configured. Add one in Settings — X-Ray works without AI too.' });
    return;
  }
  if (!isConfigured(provider)) {
    store.set({ aiError: `${provider.label} needs an API endpoint, model and API key before it can answer.` });
    return;
  }

  const userTurn: ChatTurn = { role: 'user', content: question };
  const history = state.chat;
  askController?.abort();
  // This request's own controller: a newer question replaces the module-level
  // one, so checking that instead would report an aborted request as a failure
  // and leave a phantom error in the transcript.
  const controller = new AbortController();
  askController = controller;

  store.set({
    chat: [...history, userTurn],
    aiBusy: true,
    aiError: null,
    streamBuffer: '',
  });

  const contextOptions = { maxFiles: 10, maxTokens: 14000 };

  try {
    const result = await askCodebase({
      session,
      provider,
      question,
      selectedNodeId: state.selectedNodeId,
      history,
      contextOptions,
      signal: controller.signal,
      onToken: (chunk) => store.set({ streamBuffer: store.get().streamBuffer + chunk }),
      onContext: (context) => store.set({ aiContext: context }),
    });

    const assistantTurn: ChatTurn = {
      role: 'assistant',
      content: result.answer,
      context: result.context,
      referenced: result.referenced,
    };
    store.set({
      chat: [...store.get().chat, assistantTurn],
      aiBusy: false,
      streamBuffer: '',
      aiContext: result.context,
    });

    if (result.referenced.length > 0) {
      const ids = new Set<string>(result.referenced.map((node) => node.id));
      const selected = store.get().selectedNodeId;
      if (selected) ids.add(selected);
      store.set({ highlighted: ids, highlightReason: `Components referenced in the answer` });
    }
  } catch (err) {
    if (controller.signal.aborted) {
      // The user pressed Stop, or asked again and replaced this request.
      store.set({ aiBusy: false, streamBuffer: '' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const detail = (err as { detail?: string }).detail;
    // A failed request answers in place, once. The transcript is the durable
    // record of the conversation, so the explanation belongs there rather than
    // being repeated in the error strip above the composer as well.
    store.set({
      aiBusy: false,
      streamBuffer: '',
      aiError: null,
      chat: [
        ...store.get().chat,
        { role: 'assistant', content: detail ? `${message}\n\n${detail}` : message, error: true },
      ],
    });
  } finally {
    askController = null;
  }
}

export function focusReferencedNodes(ids: string[]): void {
  if (ids.length === 0) return;
  store.set({ highlighted: new Set(ids), highlightReason: 'Referenced in the AI answer' });
}

// --- helpers ---------------------------------------------------------------

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
