import { useEffect, useState } from 'react';
import type { AuthStatus } from '../api.js';

/**
 * The moment after connecting.
 *
 * It exists for one reason: to show *whose* account is now connected. Signing in as the wrong
 * GitHub identity — a personal account instead of a work one — is otherwise invisible until
 * something confusing happens hours later. A face fixes that in half a second.
 *
 * It dismisses itself. Anything the user has to click here would be a step for nothing.
 */
export function Connected({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const settle = setTimeout(() => setLeaving(true), 1400);
    const done = setTimeout(onDone, 1750);
    return () => {
      clearTimeout(settle);
      clearTimeout(done);
    };
  }, [onDone]);

  return (
    <div className={`stage ${leaving ? 'leaving' : ''}`}>
      <div className="stage-inner">
        {status.avatarUrl ? (
          <img className="avatar-lg rise" src={status.avatarUrl} alt="" />
        ) : (
          <div className="mark" aria-hidden="true">
            ¶
          </div>
        )}
        <h1 className="wordmark rise">Hello, {status.login}</h1>
        <p className="lede rise delay">You're connected.</p>
        <button className="btn link" onClick={onDone}>
          Continue
        </button>
      </div>
    </div>
  );
}
