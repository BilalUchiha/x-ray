import { useSyncExternalStore } from 'react';
import type { AnalysisProgress } from '../core/analysis/analyze';
import type { AnalysisSession, EdgeKind } from '../core/types';
import type { ImpactResult } from '../core/analysis/impact';
import type { SearchResult } from '../core/search/search';
import type { ChatTurn } from '../core/ai/chat';
import type { AiContext } from '../core/ai/context';
import type { AiSettings } from '../core/settings/aiSettings';
import type { WorkspaceRecord } from '../core/storage/workspaces';

export type Screen = 'welcome' | 'analyzing' | 'dashboard';
export type NavSection = 'overview' | 'structure' | 'dependencies' | 'impact' | 'ai' | 'settings';

export interface ConnectionTest {
  ok: boolean;
  message: string;
  detail?: string;
}

export interface AppState {
  screen: Screen;
  folderName: string | null;
  session: AnalysisSession | null;
  /** True when a session came from saved storage and has no source loaded. */
  sourceAvailable: boolean;

  progress: AnalysisProgress | null;
  completedPhases: string[];
  analysisError: string | null;

  nav: NavSection;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;

  searchQuery: string;
  searchResults: SearchResult[];

  highlighted: Set<string>;
  highlightReason: string | null;
  impactDepth: number;
  impact: ImpactResult | null;

  expandedGroups: Set<string>;
  expandedTypes: Set<string>;
  /**
   * Structural boxes (the project, a workspace, an app) the user has folded
   * shut. Their whole subtree is left out of the map until they are unfolded.
   */
  collapsedSubtree: Set<string>;
  hiddenEdgeKinds: Set<EdgeKind>;
  showEdgeLabels: boolean;
  /** Whether the inspector column is visible (an overlay drawer when narrow). */
  inspectorOpen: boolean;
  /**
   * Whether the companion map is shown beside the chat. It starts hidden on
   * narrow windows, where the conversation needs the whole stage.
   */
  aiMapOpen: boolean;

  aiSettings: AiSettings;
  chat: ChatTurn[];
  aiContext: AiContext | null;
  aiBusy: boolean;
  aiError: string | null;
  streamBuffer: string;
  connectionTest: ConnectionTest | null;
  testingConnection: boolean;

  workspaces: WorkspaceRecord[];
  showWarnings: boolean;
  toast: string | null;
}

export const initialState: AppState = {
  screen: 'welcome',
  folderName: null,
  session: null,
  sourceAvailable: false,

  progress: null,
  completedPhases: [],
  analysisError: null,

  nav: 'overview',
  selectedNodeId: null,
  hoveredNodeId: null,

  searchQuery: '',
  searchResults: [],

  highlighted: new Set<string>(),
  highlightReason: null,
  impactDepth: 1,
  impact: null,

  expandedGroups: new Set<string>(),
  expandedTypes: new Set<string>(),
  collapsedSubtree: new Set<string>(),
  hiddenEdgeKinds: new Set<EdgeKind>(),
  showEdgeLabels: false,
  // On narrow windows the inspector is an overlay, so start it closed rather
  // than covering the map.
  inspectorOpen: typeof window === 'undefined' ? true : window.innerWidth >= 960,
  aiMapOpen: typeof window === 'undefined' ? true : window.innerWidth >= 1100,

  aiSettings: { providers: [], activeProviderId: null },
  chat: [],
  aiContext: null,
  aiBusy: false,
  aiError: null,
  streamBuffer: '',
  connectionTest: null,
  testingConnection: false,

  workspaces: [],
  showWarnings: false,
  toast: null,
};

type Listener = () => void;

class Store {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppState => this.state;

  get = (): AppState => this.state;

  set = (patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void => {
    const resolved = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...resolved };
    for (const listener of this.listeners) listener();
  };

  reset = (): void => {
    this.state = { ...initialState, aiSettings: this.state.aiSettings, workspaces: this.state.workspaces };
    for (const listener of this.listeners) listener();
  };
}

export const store = new Store();

/** Subscribes to the whole state object. Components destructure what they need. */
export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string): void {
  store.set({ toast: message });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.set({ toast: null }), 4200);
}
