import type { ThemePref } from './theme.js';

const OPTIONS: Array<{ value: ThemePref; label: string; glyph: string }> = [
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'system', label: 'Match system', glyph: '◐' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
];

/**
 * Three states, not a toggle.
 *
 * A two-way switch cannot express "follow the system", which is the setting most people
 * actually want — and once flipped, a toggle silently stops following it forever. macOS
 * settles this the same way, and so does every app that gets it right.
 */
export function ThemeSwitch({ pref, onChange }: { pref: ThemePref; onChange: (next: ThemePref) => void }) {
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={pref === option.value}
          className={`theme-opt ${pref === option.value ? 'on' : ''}`}
          title={option.label}
          onClick={() => onChange(option.value)}
        >
          <span aria-hidden="true">{option.glyph}</span>
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
