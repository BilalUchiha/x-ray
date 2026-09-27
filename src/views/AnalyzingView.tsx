import type { AnalysisProgress } from '../core/analysis/analyze';
import { cancelAnalysis } from '../state/actions';
import { useAppState } from '../state/store';

const PHASES: Array<{ id: AnalysisProgress['phase']; label: string }> = [
  { id: 'scanning', label: 'Scanning files' },
  { id: 'languages', label: 'Detecting languages' },
  { id: 'parsing', label: 'Parsing source code' },
  { id: 'symbols', label: 'Finding symbols' },
  { id: 'dependencies', label: 'Finding dependencies' },
  { id: 'graph', label: 'Building code graph' },
];

export function AnalyzingView() {
  const state = useAppState();
  const progress = state.progress;
  const completed = new Set(state.completedPhases);
  const activeIndex = progress ? PHASES.findIndex((phase) => phase.id === progress.phase) : 0;
  const counters = progress?.counters ?? {};

  const percent = progress
    ? Math.min(100, Math.round(((activeIndex + (progress.total > 0 ? progress.completed / progress.total : 0.3)) / PHASES.length) * 100))
    : 4;

  return (
    <div className="analyzing">
      <div className="analyzing-inner">
        <div className="row between" style={{ marginBottom: 4 }}>
          <h2>Analyzing {state.folderName ?? 'folder'}…</h2>
          <button type="button" className="btn ghost sm" onClick={cancelAnalysis}>
            Cancel
          </button>
        </div>
        <div className="sub">
          Reading the folder locally. Nothing is uploaded and nothing is written into the project.
        </div>

        <div className="phase-list">
          {PHASES.map((phase, index) => {
            const isActive = activeIndex === index && progress?.phase === phase.id;
            const isDone = completed.has(phase.id) && !isActive && index < activeIndex + 1 && activeIndex > index;
            const detail = isActive ? progress?.detail ?? activeDetail(progress) : '';
            return (
              <div key={phase.id} className={`phase ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                <span className="phase-mark">{isDone ? '✓' : ''}</span>
                <span>{phase.label}</span>
                {detail && <span className="phase-detail">{detail}</span>}
              </div>
            );
          })}
        </div>

        <div className="progress-line">
          <div style={{ width: `${percent}%` }} />
        </div>
        <div className="row between split-note">
          <span>{progress?.label ?? 'Starting…'}</span>
          <span className="mono">{percent}%</span>
        </div>

        <div className="analyzing-tally" style={{ marginTop: 22 }}>
          <Tally value={counters.files} label="files" />
          <Tally value={counters.sourceFiles} label="source files" />
          <Tally value={counters.types} label="types" />
          <Tally value={counters.members} label="members" />
          <Tally value={counters.relationships} label="relationships" />
        </div>
      </div>
    </div>
  );
}

function activeDetail(progress: AnalysisProgress | null): string {
  if (!progress) return '';
  if (progress.total > 0 && progress.phase !== 'symbols' && progress.phase !== 'dependencies') {
    return `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`;
  }
  return '';
}

function Tally({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="tally-cell">
      <div className="value">{value === undefined ? '—' : value.toLocaleString()}</div>
      <div className="label">{label}</div>
    </div>
  );
}
