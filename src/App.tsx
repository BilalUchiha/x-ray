import { useEffect } from 'react';
import { useAppState } from './state/store';
import { initApp } from './state/actions';
import { WelcomeView } from './views/WelcomeView';
import { AnalyzingView } from './views/AnalyzingView';
import { DashboardView } from './views/DashboardView';

export function App() {
  const state = useAppState();

  useEffect(() => {
    void initApp();
  }, []);

  return (
    <>
      {state.screen === 'welcome' && <WelcomeView />}
      {state.screen === 'analyzing' && <AnalyzingView />}
      {state.screen === 'dashboard' && <DashboardView />}
      {state.toast && <div className="toast">{state.toast}</div>}
    </>
  );
}
