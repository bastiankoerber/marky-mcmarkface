import { useEffect, useState } from 'react';
import { api, type AuthStatus, type DeviceStart } from '../api.js';
import { Loading } from '../Loading.jsx';
import { BrandIcon } from '../BrandIcon.jsx';
import { authPhaseAfterBootstrap } from './bootstrap-policy.js';

/**
 * First run.
 *
 * The whole screen is one sentence and one button. Everything else — scopes, the GitHub CLI
 * shortcut, device codes, pasting a token — is behind progressive disclosure, because on first
 * run the user has not yet decided they care about any of it. Someone who wants the detail can
 * find it in one click; someone who doesn't never sees it.
 */
export function Connect({
  status,
  error,
  onConnected,
}: {
  status: AuthStatus;
  error?: string | null;
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'access' | 'leaving' | 'device' | 'bootstrap'>('idle');
  const [failure, setFailure] = useState<string | null>(error ?? null);
  const [showAccess, setShowAccess] = useState(false);
  const [showOther, setShowOther] = useState(false);

  useEffect(() => {
    setFailure(error ?? null);
    if (error) setPhase('idle');
  }, [error]);

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null);
    try {
      await fn();
      onConnected();
    } catch (err) {
      setFailure((err as Error).message);
    }
  };

  /** One click. Desktop keeps the app open and uses the system browser; web returns in this tab. */
  const openGitHub = async () => {
    setFailure(null);
    setPhase('leaving');
    try {
      const { url } = await api.oauthStart();
      if (status.desktop) window.open(url, '_blank', 'noopener,noreferrer');
      else window.location.assign(url);
    } catch (err) {
      setPhase('idle');
      setFailure((err as Error).message);
    }
  };

  if (status.storage === 'locked') return <UnlockConnection onChanged={onConnected} />;
  if (status.pending) return <StorageChoice pending={status.pending} onChanged={onConnected} />;

  // Success arrives over SSE and App re-reads auth status, so DeviceCode needs no callback.
  if (phase === 'device') return <DeviceCode onCancel={() => setPhase('idle')} />;
  if (phase === 'bootstrap') {
    return (
      <Bootstrap
        status={status}
        onCancel={() => setPhase('idle')}
        onSaved={(nextPhase) => {
          setPhase(nextPhase);
          onConnected();
        }}
      />
    );
  }
  if (phase === 'access') {
    return <GitHubAccess onCancel={() => setPhase('idle')} onContinue={() => void openGitHub()} />;
  }

  return (
    <div className="stage">
      <div className="stage-inner">
        <Mark animate={phase === 'leaving'} />
        <h1 className="wordmark">Marky McMarkface</h1>
        <p className="lede">Review Markdown pull requests the way they will be read.</p>

        {phase === 'leaving' ? (
          <p className="status-line">Opening GitHub…</p>
        ) : status.oauthConfigured ? (
          <button className="btn primary large" onClick={() => setPhase('access')}>
            Connect GitHub
          </button>
        ) : status.deviceFlowConfigured ? (
          <button className="btn primary large" onClick={() => setPhase('device')}>
            Connect GitHub
          </button>
        ) : status.gh.loggedIn ? (
          <>
            <button className="btn primary large" onClick={() => void run(api.connectGh)}>
              Continue as @{status.gh.login}
            </button>
            {/*
              Not "set up one-click sign-in". This *is* the finished path — it reuses an
              authorisation you already granted, with nothing to register. Calling the secondary
              option "set up" implied the primary one was a stopgap.
            */}
            <button className="btn link" onClick={() => setPhase('bootstrap')}>
              Use a browser sign-in instead
            </button>
          </>
        ) : status.gh.available ? (
          /*
             `gh` is installed but signed out. One command fixes that, and it is a far smaller
             ask than registering an OAuth application — which is where this branch used to send
             people, because it only checked `loggedIn`.
          */
          <>
            <p className="status-line">
              The GitHub CLI is installed but signed out. Run this, then come back:
            </p>
            <code className="command">gh auth login</code>
            <button className="btn primary large" onClick={onConnected}>
              I've signed in
            </button>
            <button className="btn link" onClick={() => setPhase('bootstrap')}>
              Connect without the CLI
            </button>
          </>
        ) : (
          <button className="btn primary large" onClick={() => setPhase('bootstrap')}>
            Set up Marky McMarkface
          </button>
        )}

        {failure && <p className="failure">{failure}</p>}

        <div className="quiet-links">
          <button className="btn link" onClick={() => setShowAccess(!showAccess)}>
            What Marky McMarkface can access
          </button>
          <button className="btn link" onClick={() => setShowOther(!showOther)}>
            Other ways to connect
          </button>
        </div>

        {showAccess && (
          <div className="disclosure">
            <p>
              <strong>Marky McMarkface can</strong> read repository contents, pull requests, and
              organisation membership available to your account. It posts reviews, replies, and
              resolves threads only when you ask it to.
            </p>
            <p>
              <strong>It does not implement</strong> pushing commits, merging pull requests,
              deleting repositories, or changing repository settings. Your Mac and GitHub
              passwords never reach the app, and there is no hosted Marky McMarkface service or
              analytics system.
            </p>
            <p className="muted small">
              GitHub's classic <code>repo</code> scope is broader than these implemented features.
              You can instead paste a fine-grained token under “Other ways to connect”.
            </p>
          </div>
        )}

        {showOther && (
          <div className="disclosure">
            {status.gh.loggedIn && status.oauthConfigured && (
              <div className="alt">
                <button className="btn" onClick={() => void run(api.connectGh)}>
                  Use the GitHub CLI login (@{status.gh.login})
                </button>
                {status.gh.excessScopes && status.gh.excessScopes.length > 0 && (
                  <p className="muted small">
                    Instant, but that token belongs to the GitHub CLI, so Marky McMarkface's requests appear
                    in audit logs as “GitHub CLI”. It also carries{' '}
                    <code>{status.gh.excessScopes.join(', ')}</code>, which Marky McMarkface never needs.
                  </p>
                )}
              </div>
            )}

            {status.deviceFlowConfigured && (
              <div className="alt">
                <button className="btn" onClick={() => setPhase('device')}>
                  Enter a code instead
                </button>
                <p className="muted small">
                  For when this machine can't open a browser — over SSH, or on a remote box.
                </p>
              </div>
            )}

            <PasteToken onSubmit={(token) => run(() => api.connectPat(token))} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The product mark. It breathes only while we're waiting on something. */
function Mark({ animate }: { animate: boolean }) {
  return (
    <div className={`mark ${animate ? 'breathing' : ''}`} aria-hidden="true">
      <BrandIcon className="mark-logo" size={104} />
    </div>
  );
}

function GitHubAccess({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  return (
    <div className="stage">
      <div className="stage-inner trust-stage">
        <Mark animate={false} />
        <h1 className="wordmark">Before GitHub opens</h1>
        <p className="lede">GitHub will ask you to authorise this local application.</p>

        <div className="trust-card">
          <h2>What Marky McMarkface uses</h2>
          <ul className="trust-list can">
            <li>Read repositories, Markdown files, pull requests, and organisation membership you can access.</li>
            <li>Post reviews and replies, or resolve a thread, only when you choose that action.</li>
            <li>Talk directly from this Mac to GitHub. There is no hosted Marky service or analytics system.</li>
          </ul>

          <h2>What it does not implement</h2>
          <ul className="trust-list cannot">
            <li>Push commits, merge pull requests, delete repositories, or change repository settings.</li>
            <li>Receive your GitHub password or your Mac login password.</li>
          </ul>

          <p className="scope-note">
            GitHub's classic <code>repo</code> scope is broader than these implemented features.
            For narrower access, you can use a fine-grained personal token instead.
          </p>
        </div>

        <button className="btn primary large" onClick={onContinue}>
          Continue to GitHub
        </button>
        <button className="btn link" onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  );
}

function StorageChoice({
  pending,
  onChanged,
}: {
  pending: NonNullable<AuthStatus['pending']>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'keychain' | 'session' | 'cancel' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const finish = async (mode: 'keychain' | 'session') => {
    setBusy(mode);
    setFailure(null);
    try {
      await api.finishConnection(mode);
      onChanged();
    } catch (err) {
      setFailure((err as Error).message);
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    setFailure(null);
    try {
      await api.cancelConnection();
      onChanged();
    } catch (err) {
      setFailure((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="stage">
      <div className="stage-inner trust-stage">
        {pending.avatarUrl ? <img className="avatar-lg" src={pending.avatarUrl} alt="" /> : <Mark animate={false} />}
        <h1 className="wordmark">Protect your GitHub connection</h1>
        <p className="lede">GitHub approved @{pending.login}. Now choose where its access token lives.</p>

        <div className="trust-card keychain-explainer">
          <h2>If you save it securely</h2>
          <p>
            macOS will ask Marky McMarkface to access an item named{' '}
            <strong>“Marky McMarkface Safe Storage”</strong> in your login keychain.
          </p>
          <p>
            That item is an app-specific encryption key used to protect your GitHub token. The
            password box belongs to macOS: Marky McMarkface cannot see or store what you type, and
            it cannot use this request to read unrelated Keychain items.
          </p>
          <details>
            <summary>What do Allow, Always Allow, and Deny mean?</summary>
            <ul className="trust-list compact">
              <li><strong>Allow</strong> permits this access once.</li>
              <li><strong>Always Allow</strong> remembers it for this signed build.</li>
              <li><strong>Deny</strong> stores nothing. You can retry or use session-only access.</li>
            </ul>
            <p className="scope-note">The dialog expects your Mac login password, not your GitHub password.</p>
          </details>
        </div>

        {failure && <p className="failure">{failure}</p>}

        <div className="trust-actions">
          <button className="btn primary large" disabled={busy !== null} onClick={() => void finish('keychain')}>
            {busy === 'keychain' ? 'Waiting for macOS…' : 'Continue to macOS'}
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void finish('session')}>
            {busy === 'session' ? 'Connecting…' : 'Use until I quit'}
          </button>
        </div>
        <p className="status-line">Session-only access is kept in memory and is never written to disk.</p>
        <button className="btn link" disabled={busy !== null} onClick={() => void cancel()}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel connection'}
        </button>
      </div>
    </div>
  );
}

function UnlockConnection({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState<'unlock' | 'forget' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const unlock = async () => {
    setBusy('unlock');
    setFailure(null);
    try {
      await api.unlockConnection();
      onChanged();
    } catch (err) {
      setFailure((err as Error).message);
      setBusy(null);
    }
  };

  const forget = async () => {
    const confirmed = window.confirm(
      'Remove the saved connection from this Mac? This does not revoke the application on GitHub.',
    );
    if (!confirmed) return;
    setBusy('forget');
    setFailure(null);
    try {
      await api.forgetConnection();
      onChanged();
    } catch (err) {
      setFailure((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="stage">
      <div className="stage-inner trust-stage">
        <Mark animate={false} />
        <h1 className="wordmark">Unlock your saved connection</h1>
        <p className="lede">An encrypted GitHub connection is stored on this Mac.</p>

        <div className="trust-card keychain-explainer">
          <p>
            Continuing may make macOS ask for access to{' '}
            <strong>“Marky McMarkface Safe Storage”</strong>. It is the app-specific encryption key
            that protects your GitHub token.
          </p>
          <p>
            Any password is entered into a macOS dialog and is never visible to Marky McMarkface.
            Selecting <strong>Deny</strong> leaves the saved connection unchanged.
          </p>
        </div>

        {failure && <p className="failure">{failure}</p>}

        <button className="btn primary large" disabled={busy !== null} onClick={() => void unlock()}>
          {busy === 'unlock' ? 'Waiting for macOS…' : 'Continue to macOS'}
        </button>
        <button className="btn link danger" disabled={busy !== null} onClick={() => void forget()}>
          {busy === 'forget' ? 'Removing…' : 'Forget saved connection'}
        </button>
        <p className="status-line">Forgetting it locally does not revoke access on GitHub.</p>
      </div>
    </div>
  );
}

/**
 * One-time bootstrap, for whoever sets up this copy of Marky McMarkface.
 *
 * This screen should not exist for most people. GitHub has no Dynamic Client Registration — the
 * mechanism that lets Claude's connectors register themselves — so a client ID has to come from
 * somewhere. Every comparable tool answers that by shipping one in source: opencode hardcodes
 * `Ov23li8tweQw6odWQebz` for Copilot, the GitHub CLI hardcodes `178c6fc778ccc68e1d6a`. Once this
 * project's ID is committed, nobody sees this screen again.
 *
 * The client secret is optional on purpose. With it you get one-click sign-in; without it,
 * Marky McMarkface uses device flow, which needs no secret — so a fork can ship a working default without
 * committing a credential at all.
 */
function Bootstrap({
  status,
  onCancel,
  onSaved,
}: {
  status: AuthStatus;
  onCancel: () => void;
  onSaved: (nextPhase: 'access' | 'device') => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.oauthConfigure(clientId, clientSecret);
      onSaved(authPhaseAfterBootstrap(clientSecret));
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stage">
      <div className="stage-inner">
        <Mark animate={false} />
        <h1 className="wordmark">Set up Marky McMarkface</h1>
        <p className="lede">
          Once per installation. Register Marky McMarkface with GitHub, paste the ID back here, and you're
          done — for good.
        </p>

        <div className="setup">
          <ol>
            <li>
              <a className="btn" href={status.registrationUrl} target="_blank" rel="noreferrer">
                Open the prefilled form on GitHub
              </a>
              <span className="muted">
                Name and callback URL are filled in. Tick <strong>Enable Device Flow</strong>, then
                press <strong>Register application</strong>.
              </span>
            </li>
            <li>
              Paste the <strong>Client ID</strong> here.
              <input
                autoFocus
                placeholder="Iv1.a1b2c3d4e5f6…"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && clientId.trim() && void save()}
              />
            </li>
            <li>
              Optional: generate a client secret and paste it too, for one-click sign-in instead
              of entering a code.
              <input
                type="password"
                autoComplete="off"
                placeholder="Leave empty to use device codes"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </li>
          </ol>
        </div>

        {failure && <p className="failure">{failure}</p>}

        <button className="btn primary large" disabled={busy || !clientId.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>

        <div className="quiet-links">
          <button className="btn link" onClick={onCancel}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

function PasteToken({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');

  if (!open) {
    return (
      <div className="alt">
        <button className="btn link" onClick={() => setOpen(true)}>
          Paste a personal access token
        </button>
      </div>
    );
  }

  return (
    <form
      className="alt paste"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(token.trim());
      }}
    >
      <input
        type="password"
        autoComplete="off"
        placeholder="ghp_… or a fine-grained token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button className="btn" disabled={!token.trim()}>
        Connect
      </button>
      <p className="muted small">
        For company repositories, a fine-grained token must name the organisation as its resource
        owner and may need owner approval. A classic token may need <strong>Configure SSO</strong>
        in GitHub's token settings.
      </p>
    </form>
  );
}

/**
 * Device code — the fallback for machines that cannot open a browser.
 *
 * One button does all three things at once: copies the code, opens the prefilled GitHub page,
 * and starts polling. The countdown is real (GitHub expires the code in 15 minutes) rather than
 * an indeterminate spinner that tells the user nothing.
 */
function DeviceCode({ onCancel }: { onCancel: () => void }) {
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const request = async () => {
    setFailure(null);
    setDevice(null);
    try {
      const next = await api.deviceStart();
      setDevice(next);
      setRemaining(next.expiresIn);
    } catch (err) {
      setFailure((err as Error).message);
    }
  };

  useEffect(() => {
    void request();
    return () => void api.deviceCancel().catch(() => {});
  }, []);

  useEffect(() => {
    if (!device) return;
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [device]);

  const go = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      setCopied(true);
    } catch {
      /* clipboard permission is not required; the code is on screen either way */
    }
    window.open(device.verificationUriComplete, '_blank', 'noreferrer');
  };

  const expired = device !== null && remaining === 0;

  return (
    <div className="stage">
      <div className="stage-inner">
        <Mark animate={!expired && device !== null} />
        <h1 className="wordmark">Marky McMarkface</h1>

        {failure && <p className="failure">{failure}</p>}

        {!device && !failure && <Loading variant="inline" line="Asking GitHub for a code…" />}

        {device && (
          <>
            <p className="lede">Enter this code on GitHub.</p>
            <div className="code" aria-label={device.userCode.split('').join(' ')}>
              {device.userCode}
            </div>

            {expired ? (
              <>
                <p className="status-line">That code expired.</p>
                <button className="btn primary large" onClick={() => void request()}>
                  Get a new code
                </button>
              </>
            ) : (
              <>
                <button className="btn primary large" onClick={() => void go()}>
                  {copied ? 'Copied — open GitHub' : 'Copy code and open GitHub'}
                </button>
                <p className="status-line">
                  Waiting for you to approve · expires in {Math.floor(remaining / 60)}:
                  {String(remaining % 60).padStart(2, '0')}
                </p>
              </>
            )}
          </>
        )}

        <div className="quiet-links">
          <button
            className="btn link"
            onClick={() => {
              void api.deviceCancel().catch(() => {});
              onCancel();
            }}
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
