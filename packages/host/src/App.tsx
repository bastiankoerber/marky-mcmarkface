import { useCallback, useEffect, useState } from 'react';
import { api, subscribe, type AuthStatus, type DashboardData, type Prefs } from './api.js';
import { Connect } from './onboarding/Connect.jsx';
import { Connected } from './onboarding/Connected.jsx';
import { Dashboard } from './dashboard/Dashboard.jsx';
import { Review } from './review/Review.jsx';

type Data = DashboardData & { prefs: Prefs; staleError?: string | null };
type View = { kind: 'dashboard' } | { kind: 'review'; owner: string; repo: string; number: number };

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [view, setView] = useState<View>(parseHash());
  const [celebrating, setCelebrating] = useState(false);

  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.authStatus());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Coming back from GitHub. Read the outcome, then clear it out of the URL so a refresh
  // doesn't replay it, and so the address bar isn't carrying query junk around.
  useEffect(() => {
    const outcome = readConnectOutcome();
    if (!outcome) return;
    history.replaceState(null, '', window.location.pathname);
    if (outcome.error) setAuthError(outcome.error);
    else setCelebrating(true);
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => void loadStatus(), [loadStatus]);

  useEffect(() => {
    if (!status?.connected) return;
    void loadDashboard();
  }, [status?.connected, loadDashboard]);

  // The server polls GitHub and pushes here, so N open tabs cost one poller, not N.
  useEffect(() => {
    return subscribe({
      dashboard: (payload) => setData((prev) => ({ ...(payload as DashboardData), prefs: prev?.prefs ?? emptyPrefs })),
      auth: () => {
        setCelebrating(true);
        void loadStatus();
      },
      'auth-error': (payload) => setAuthError((payload as { message: string }).message),
      error: (payload) => setError((payload as { message: string }).message),
    });
  }, [loadStatus]);

  // Tell the server when this window is in the background so it can back off from 60s to 5min.
  useEffect(() => {
    const report = () => void api.setFocus(document.visibilityState === 'visible').catch(() => {});
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, []);

  const navigate = (next: View) => {
    window.location.hash = next.kind === 'dashboard' ? '' : `#/pr/${next.owner}/${next.repo}/${next.number}`;
    setView(next);
  };

  if (!status) return <Splash />;

  if (!status.connected) {
    return <Connect status={status} error={authError} onConnected={loadStatus} />;
  }

  // One beat on the face of the account that just connected. This is the only thing that
  // catches "signed in as the wrong GitHub user", which is otherwise invisible for hours.
  if (celebrating) {
    return <Connected status={status} onDone={() => setCelebrating(false)} />;
  }

  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => navigate({ kind: 'dashboard' })}>
          <span className="brand-mark">¶</span> Pilcrow
        </button>
        <span className="spacer" />
        {status.avatarUrl && <img className="avatar-sm" src={status.avatarUrl} alt="" />}
        <span className="muted small">@{status.login}</span>
        <button
          className="btn link small"
          onClick={async () => {
            await api.signOut();
            setData(null);
            void loadStatus();
          }}
        >
          Sign out
        </button>
      </nav>

      {error && <div className="banner warn">{error}</div>}

      {view.kind === 'review' ? (
        // Keyed by pull request so switching PRs remounts rather than reusing state. Without
        // this, a hash change keeps the component alive and the pending-comment buffer follows
        // you to the next pull request — where submitting would post to the wrong PR.
        <Review
          key={`${view.owner}/${view.repo}/${view.number}`}
          owner={view.owner}
          repo={view.repo}
          number={view.number}
          onBack={() => navigate({ kind: 'dashboard' })}
        />
      ) : data ? (
        <Dashboard
          data={data}
          onOpen={(owner, repo, number) => navigate({ kind: 'review', owner, repo, number })}
          onPrefs={(prefs) => setData((prev) => (prev ? { ...prev, prefs } : prev))}
          onRefresh={() => void api.refresh().then(loadDashboard)}
        />
      ) : (
        <Splash line="Fetching your pull requests…" />
      )}
    </div>
  );
}

function Splash({ line }: { line?: string }) {
  return (
    <div className="stage">
      <div className="stage-inner">
        <div className="mark breathing" aria-hidden="true">
          ¶
        </div>
        {line && <p className="status-line">{line}</p>}
      </div>
    </div>
  );
}

const emptyPrefs: Prefs = { pinnedRepos: [], pinCardDismissed: false, viewerOverrides: {}, viewed: [] };

function parseHash(): View {
  const match = /^#\/pr\/([^/]+)\/([^/]+)\/(\d+)$/.exec(window.location.hash);
  if (!match) return { kind: 'dashboard' };
  return { kind: 'review', owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** `#/connected?ok=1` or `#/connected?error=…`, written by the server's OAuth callback. */
function readConnectOutcome(): { error?: string } | null {
  const hash = window.location.hash;
  if (!hash.startsWith('#/connected')) return null;
  const query = hash.slice(hash.indexOf('?') + 1);
  const params = new URLSearchParams(hash.includes('?') ? query : '');
  const error = params.get('error');
  return error ? { error } : {};
}
