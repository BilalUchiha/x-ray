import type { Analysis, AnalysisSession, LanguageStat, ProjectStats } from '../types';
import { idbDelete, idbGet, idbGetAll, idbPut, STORE_ANALYSES, STORE_WORKSPACES } from './db';

export interface WorkspaceRecord {
  id: string;
  name: string;
  /** How the folder was opened: 'picker', 'drop' or 'sample'. */
  rootLabel: string;
  analyzedAt: number;
  stats: ProjectStats;
  languages: LanguageStat[];
  /**
   * A browser cannot silently regain access to a folder the user picked
   * earlier, so a saved workspace always needs the folder re-selected before
   * source code can be used again.
   */
  hasSource: false;
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const all = await idbGetAll<WorkspaceRecord>(STORE_WORKSPACES);
  return all.sort((a, b) => b.analyzedAt - a.analyzedAt);
}

export async function saveWorkspace(session: AnalysisSession): Promise<WorkspaceRecord> {
  const { analysis } = session;
  const record: WorkspaceRecord = {
    id: analysis.id,
    name: analysis.name,
    rootLabel: analysis.rootLabel,
    analyzedAt: analysis.analyzedAt,
    stats: analysis.stats,
    languages: analysis.languages,
    hasSource: false,
  };
  await idbPut(STORE_WORKSPACES, record);
  await idbPut(STORE_ANALYSES, analysis);
  return record;
}

export async function loadAnalysis(id: string): Promise<Analysis | undefined> {
  return idbGet<Analysis>(STORE_ANALYSES, id);
}

export async function deleteWorkspace(id: string): Promise<void> {
  await idbDelete(STORE_WORKSPACES, id);
  await idbDelete(STORE_ANALYSES, id);
}

export async function clearWorkspaces(): Promise<void> {
  const all = await listWorkspaces();
  for (const workspace of all) await deleteWorkspace(workspace.id);
}
