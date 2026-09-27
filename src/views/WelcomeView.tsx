import { useState } from 'react';
import { folderFromDataTransfer } from '../core/fs/source';
import { analyzeSource, canPickFolder, chooseFolder, openSampleProject, openStoredWorkspace, removeWorkspace } from '../state/actions';
import { useAppState } from '../state/store';

export function WelcomeView() {
  const state = useAppState();
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const pickerSupported = canPickFolder();
  const error = state.analysisError ?? dropError;

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    setDropError(null);
    const folder = folderFromDataTransfer(event.dataTransfer);
    if (!folder) {
      setDropError('Drop a folder, not individual files.');
      return;
    }
    void analyzeSource(folder);
  };

  return (
    <div
      className="welcome"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="welcome-inner">
        <h1 className="wordmark">
          X<span>—</span>RAY
        </h1>
        <h2>See how your codebase works.</h2>
        <p className="lede">
          Select a local folder and X-Ray will map its structure, dependencies and relationships.
        </p>

        {error && (
          <div className="notice error" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <div>
              <strong>Could not analyse that folder.</strong>
              <div className="muted" style={{ marginTop: 2 }}>{error}</div>
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
          <button type="button" className="btn primary lg" onClick={() => void chooseFolder()} disabled={!pickerSupported}>
            Choose Folder
          </button>
          <button type="button" className="btn lg" onClick={() => void openSampleProject()}>
            Explore sample project
          </button>
        </div>

        {!pickerSupported && (
          <div className="notice" style={{ marginTop: 14, textAlign: 'left' }}>
            <span>⚠</span>
            <div>
              This browser cannot open a folder picker. Drag a folder onto this window instead, or use a
              Chromium-based browser for the native picker.
            </div>
          </div>
        )}

        <div className={`dropzone ${dragging ? 'active' : ''}`}>
          {dragging ? 'Release to analyse this folder' : 'Drop a folder here'}
          <span className="drop-or">or</span>
          <span style={{ color: 'var(--muted)' }}>use Choose Folder above</span>
        </div>

        {state.workspaces.length > 0 && (
          <div className="workspace-list">
            <div className="section-title rule">Recent analyses</div>
            {state.workspaces.slice(0, 5).map((workspace) => (
              <div key={workspace.id} className="workspace-item">
                <div style={{ minWidth: 0, flex: 1 }} onClick={() => void openStoredWorkspace(workspace.id)}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{workspace.name}</span>
                    <span className="tag">{workspace.stats.sourceFiles} files</span>
                    <span className="tag">{workspace.stats.classes} classes</span>
                  </div>
                  <div className="mono dim" style={{ marginTop: 2 }}>
                    {new Date(workspace.analyzedAt).toLocaleString()} · structure saved · re-select folder to use source
                  </div>
                </div>
                <button
                  type="button"
                  className="btn ghost sm"
                  title="Forget this analysis"
                  onClick={() => void removeWorkspace(workspace.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="welcome-meta">
          <span>No Git required</span>
          <span className="dot">·</span>
          <span>Folders are opened read-only</span>
          <span className="dot">·</span>
          <span>Nothing is written into your project</span>
          <span className="dot">·</span>
          <span>AI is optional</span>
        </div>
      </div>
    </div>
  );
}
