import { useEffect, useState } from 'react';

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
 * The mark is the pilcrow itself, drawn as a stroke that writes itself and repeats. It is the
 * product's own glyph rather than a generic spinner, and it costs one SVG path.
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
      <PilcrowMark />
      <p className="loading-line">{line}</p>
      {slow && slowLine && <p className="loading-slow">{slowLine}</p>}
    </div>
  );
}

/**
 * The ¶ as a self-drawing stroke.
 *
 * `stroke-dasharray` plus an animated `stroke-dashoffset` traces the outline, so the mark writes
 * itself the way the character would be written. Under `prefers-reduced-motion` the CSS holds it
 * fully drawn and still — the glyph carries the brand on its own without moving.
 */
function PilcrowMark() {
  return (
    <svg className="loading-mark" viewBox="0 0 48 64" width="44" height="58" aria-hidden="true" focusable="false">
      <path
        className="loading-stroke"
        d="M30 6 H18 a13 13 0 0 0 0 26 h4 M30 6 v52 M38 6 h-8 M30 32 h-8"
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default Loading;
