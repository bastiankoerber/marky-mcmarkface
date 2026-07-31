import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'pilcrow.theme';

export function readThemePref(): ThemePref {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a preference by setting one attribute.
 *
 * `styles.css` states the whole palette as `light-dark()` pairs against `color-scheme`, so this
 * is the entire mechanism — there is no second stylesheet, and no class to add to individual
 * elements. Absence of the attribute means "follow the system", which is also what the document
 * looks like before this ever runs; that is why there is no flash on load.
 */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/**
 * The current preference, plus what it currently resolves to.
 *
 * Viewers are told the resolved theme rather than the preference: a plugin rendering a diff
 * needs to know which way to draw, and "system" is not an answer to that question.
 */
export function useTheme(): {
  pref: ThemePref;
  theme: Theme;
  setPref: (next: ThemePref) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [system, setSystem] = useState<Theme>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  useEffect(() => applyThemePref(pref), [pref]);

  // Following the system means following it while the app is open, not only at launch — macOS
  // switches at sunset on its own.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setPref = (next: ThemePref) => {
    setPrefState(next);
    try {
      if (next === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Not being able to remember the choice is not a reason to refuse to make it.
    }
  };

  return { pref, theme: pref === 'system' ? system : pref, setPref };
}
