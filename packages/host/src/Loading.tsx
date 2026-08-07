import { useEffect, useState } from 'react';
import { BrandIcon } from './BrandIcon.jsx';

/**
 * The one waiting state. Every place in the app that waits uses this — never a bare string.
 *
 * Three ideas, in order of how much they matter:
 *
 * 1. **Say what is being waited on.** "Loading…" tells the reader nothing. Every caller passes
 *    a specific line, so the screen always names the thing.
 * 2. **Don't animate immediately.** Anything that resolves inside ~200ms should show nothing at
 *    all; a spinner that flashes for one frame reads as jank, not as speed. The mark fades in
 *    only once the wait is real.
 * 3. **Admit when it is slow.** Past a few seconds, silence starts to feel broken, so a second
 *    line appears. It is the difference between "this is taking a moment" and "is this stuck?"
 *
 * The product mark fades in only once the wait is real, then gently settles while work continues.
 */
export function Loading({
  line,
  slowLine,
  variant = 'page',
}: {
  /** What is being waited on. Always specific: "Opening the pull request…", not "Loading…". */
  line: string;
  /** Shown once the wait stops feeling instant. */
  slowLine?: string;
  /** `page` fills the view; `inline` sits inside an existing pane. */
  variant?: 'page' | 'inline';
}) {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Below this, a fast response should look instant rather than flash a spinner.
    const appear = setTimeout(() => setVisible(true), 180);
    const patience = setTimeout(() => setSlow(true), 4000);
    return () => {
      clearTimeout(appear);
      clearTimeout(patience);
    };
  }, []);

  if (!visible) return <div className={`loading loading-${variant}`} aria-busy="true" />;

  return (
    <div className={`loading loading-${variant} shown`} role="status" aria-busy="true" aria-live="polite">
      <BrandIcon className="loading-mark" size={48} />
      <p className="loading-line">{line}</p>
      {slow && slowLine && <p className="loading-slow">{slowLine}</p>}
    </div>
  );
}

export default Loading;
