import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Start } from './pages/Start';
import { RunView } from './pages/RunView';
import { MyRuns } from './pages/MyRuns';
import { Logo } from './components/Icons';
import { navigate } from './nav';

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const runId = path.match(/^\/run\/([\w-]+)/)?.[1];
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          <Logo /> QA Agent
        </a>
        <a className="btn ghost small" style={{ marginLeft: 'auto' }} href="/runs" onClick={(e) => { e.preventDefault(); navigate('/runs'); }}>
          My tests
        </a>
      </header>
      {runId ? <RunView key={runId} id={runId} /> : path.startsWith('/runs') ? <MyRuns /> : <Start />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
