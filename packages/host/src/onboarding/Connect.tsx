import { useEffect, useState } from 'react';
import { api, type AuthStatus, type DeviceStart } from '../api.js';

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
  const [phase, setPhase] = useState<'idle' | 'leaving' | 'device' | 'bootstrap'>('idle');
  const [failure, setFailure] = useState<string | null>(error ?? null);
  const [showAccess, setShowAccess] = useState(false);
  const [showOther, setShowOther] = useState(false);

  useEffect(() => setFailure(error ?? null), [error]);

  const run = async (fn: () => Promise<unknown>) => {
    setFailure(null);
    try {
      await fn();
      onConnected();
    } catch (err) {
      setFailure((err as Error).message);
    }
  };

  /** One click. Navigate this tab to GitHub; the server catches the redirect and sends us back. */
  const connect = async () => {
    setFailure(null);
    setPhase('leaving');
    try {
      const { url } = await api.oauthStart();
      window.location.assign(url);
    } catch (err) {
      setPhase('idle');
      setFailure((err as Error).message);
    }
  };

  // Success arrives over SSE and App re-reads auth status, so DeviceCode needs no callback.
  if (phase === 'device') return <DeviceCode onCancel={() => setPhase('idle')} />;
  if (phase === 'bootstrap') {
    return <Bootstrap status={status} onCancel={() => setPhase('idle')} onSaved={onConnected} />;
  }

  return (
    <div className="stage">
      <div className="stage-inner">
        <Mark animate={phase === 'leaving'} />
        <h1 className="wordmark">Pilcrow</h1>
        <p className="lede">Review Markdown pull requests the way they will be read.</p>

        {phase === 'leaving' ? (
          <p className="status-line">Opening GitHub…</p>
        ) : status.oauthConfigured ? (
          <button className="btn primary large" onClick={() => void connect()}>
            Connect GitHub
          </button>
        ) : status.gh.loggedIn ? (
          <>
            <button className="btn primary large" onClick={() => void run(api.connectGh)}>
              Continue as @{status.gh.login}
            </button>
            <button className="btn link" onClick={() => setPhase('bootstrap')}>
              Set up one-click sign-in
            </button>
          </>
        ) : (
          <button className="btn primary large" onClick={() => setPhase('bootstrap')}>
            Set up Pilcrow
          </button>
        )}

        {failure && <p className="failure">{failure}</p>}

        <div className="quiet-links">
          <button className="btn link" onClick={() => setShowAccess(!showAccess)}>
            What Pilcrow can access
          </button>
          <button className="btn link" onClick={() => setShowOther(!showOther)}>
            Other ways to connect
          </button>
        </div>

        {showAccess && (
          <div className="disclosure">
            <p>Pilcrow reads the pull requests you can already see, and posts review comments as you.</p>
            <p>
              Your token is kept in the macOS Keychain and never reaches the browser. Nothing is
              sent anywhere except GitHub — there is no Pilcrow server.
            </p>
            <p className="muted small">
              Requested scopes: <code>repo</code>, <code>read:org</code>.
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
                    Instant, but that token belongs to the GitHub CLI, so Pilcrow's requests appear
                    in audit logs as “GitHub CLI”. It also carries{' '}
                    <code>{status.gh.excessScopes.join(', ')}</code>, which Pilcrow never needs.
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

/** The pilcrow. It breathes only while we're waiting on something. */
function Mark({ animate }: { animate: boolean }) {
  return (
    <div className={`mark ${animate ? 'breathing' : ''}`} aria-hidden="true">
      ¶
    </div>
  );
}

/**
 * One-time bootstrap, for whoever sets up this copy of Pilcrow.
 *
 * This screen should not exist for most people. GitHub has no Dynamic Client Registration — the
 * mechanism that lets Claude's connectors register themselves — so a client ID has to come from
 * somewhere. Every comparable tool answers that by shipping one in source: opencode hardcodes
 * `Ov23li8tweQw6odWQebz` for Copilot, the GitHub CLI hardcodes `178c6fc778ccc68e1d6a`. Once this
 * project's ID is committed, nobody sees this screen again.
 *
 * The client secret is optional on purpose. With it you get one-click sign-in; without it,
 * Pilcrow uses device flow, which needs no secret — so a fork can ship a working default without
 * committing a credential at all.
 */
function Bootstrap({
  status,
  onCancel,
  onSaved,
}: {
  status: AuthStatus;
  onCancel: () => void;
  onSaved: () => void;
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
      onSaved();
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
        <h1 className="wordmark">Set up Pilcrow</h1>
        <p className="lede">
          Once per installation. Register Pilcrow with GitHub, paste the ID back here, and you're
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
        <h1 className="wordmark">Pilcrow</h1>

        {failure && <p className="failure">{failure}</p>}

        {!device && !failure && <p className="status-line">Requesting a code…</p>}

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
