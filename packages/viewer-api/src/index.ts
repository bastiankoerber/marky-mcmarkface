/**
 * @marky-mcmarkface/viewer-api — the contract between the marky-mcmarkface host and a viewer plugin.
 *
 * The one rule this package exists to enforce: a viewer renders a file and reports
 * *source character offsets*. It never learns about GitHub, diff hunks, `side: LEFT|RIGHT`
 * wire values, or `start_line`. The host owns every bit of that translation.
 */

export type Side = 'LEFT' | 'RIGHT';

/** A region of a source file, as character offsets. The only vocabulary shared host<->plugin. */
export interface SourceRange {
  side: Side;
  /** 0-based, inclusive */
  start: number;
  /** 0-based, exclusive */
  end: number;
}

/**
 * W3C Web Annotation TextQuoteSelector. Computed by the host from the source string, so a
 * viewer never has to. Stored alongside the offsets so a comment survives a force-push that
 * shifted the file: offsets are tried first, the quote is the fallback.
 */
export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface SourceSelection extends SourceRange {
  quote?: TextQuote;
}

/** Where a viewer with no DOM Range (diagram node, table cell) can still anchor. */
export interface RectAnchor {
  /** Element the coordinates are relative to. */
  anchor: Element;
  /** Normalised to the anchor element: [0,0] top-left, [1,1] bottom-right. */
  shape: { left: number; top: number; right: number; bottom: number };
}

/**
 * The anchoring contract. Modelled on Hypothes.is's `Integration`, narrowed to source offsets.
 * A viewer that cannot map DOM to source declares `capabilities.sourceMapping: false` and
 * simply never registers one of these — the host degrades to file-level comments.
 */
export interface AnchoringImpl {
  /** DOM -> source. Return null when the selection is not over annotatable content. */
  describe(range: Range): SourceRange | null;
  /** source -> DOM. Return null when the region is not currently visible (collapsed section). */
  anchor(range: SourceRange): Range | RectAnchor | null;
  scrollTo(range: SourceRange): void;
  /** The scrolling element. The host watches it to reposition the comment rail. */
  contentContainer(): HTMLElement;
  /** Fires when the rendering changes shape (image loaded, diagram re-laid-out). Returns teardown. */
  onLayoutChange(cb: () => void): () => void;
}

/**
 * Declared capabilities.
 *
 * Honesty note: only `sourceMapping` carries meaning today, and even that is advisory — the host
 * infers the real answer from whether a viewer calls `registerAnchoring`. The rest are recorded
 * intent for a host that does not yet act on them. They are kept because they describe the
 * viewer accurately and cost nothing; do **not** treat any of them as an enforced guarantee.
 */
export interface ViewerCapabilities {
  /** Can this viewer map DOM selection <-> source offsets? false => file-level comments only. */
  sourceMapping: boolean;
  /** Advisory. 'native' = renders its own diff; the host does not yet mount two instances. */
  diff: 'native' | 'side-by-side' | 'new-only';
  /** Advisory. */
  anchorGranularity: 'char' | 'line' | 'block';
  /** Advisory; the host's suggestion editor does not consult this flag yet. */
  editable?: boolean;
}

/**
 * Static manifest. Evaluated before any plugin code loads, so the host builds its
 * file -> viewer table at startup at zero cost.
 */
export interface ViewerManifest {
  /** Stable unique id, e.g. "marky-mcmarkface.markdown". */
  id: string;
  displayName: string;
  /** picomatch globs, not bare extensions — lets a viewer claim `**\/docs/**\/*.md` alone. */
  selector: Array<{ filenamePattern: string }>;
  /** Lower wins. Builtins use 100, contributions default to 500. */
  rank?: number;
  /** 'option' means the user must pick it explicitly; it never auto-opens. */
  priority?: 'default' | 'option';
  /**
   * Does this viewer execute embedded content?
   *
   * **Not enforced.** Nothing in the host reads this yet, so it must not be relied on as a
   * security control — a viewer is fully-privileged same-origin code either way. It is declared
   * so the trust decision can be added later without a breaking change.
   */
  safe?: boolean;
  capabilities: ViewerCapabilities;
}

export interface DiffHunk {
  baseStart: number;
  baseLines: number;
  headStart: number;
  headLines: number;
}

export interface ResolvedAnnotation {
  id: string;
  range: SourceRange;
  author: string;
  body: string;
  resolved: boolean;
  /** True when neither offsets nor quote could be re-anchored after an upstream change. */
  orphaned: boolean;
}

export interface ViewerHost {
  /** Called by the viewer when the user finishes a selection. */
  onSelect(selection: SourceRange | null): void;
  /** Which source lines sit inside a diff hunk. The host greys out everything else. */
  commentableRanges(side: Side): Array<[number, number]>;
  requestComment(selection: SourceRange): void;
  /**
   * Turn a document-authored image source into a URL the viewer may load.
   *
   * The host owns resource access because it owns the document's trust boundary. A viewer gets
   * back a loadable URL or null; it never needs repository, credential, or provider details.
   * Optional so existing third-party viewers and hosts remain source-compatible.
   */
  resolveImageUrl?: (source: string, documentPath: string) => string | null;
  /**
   * Offer a rendered link to the host. Returning true means the host accepted navigation and
   * the viewer must prevent the browser's default action.
   */
  openLink?(href: string, documentPath: string): boolean;
  theme: 'light' | 'dark';
}

export interface ViewerFile {
  path: string;
  /** LEFT content. null means the file was added in this PR. */
  base: string | null;
  /** RIGHT content. null means the file was deleted. */
  head: string | null;
  hunks: DiffHunk[];
}

export interface ViewerProps {
  file: ViewerFile;
  annotations: ResolvedAnnotation[];
  host: ViewerHost;
  /** Call with an impl to enable prose commenting, or null to opt out. */
  registerAnchoring: (impl: AnchoringImpl | null) => void;
}

export interface PostProcessContext {
  path: string;
  side: Side;
  /** Source offset of the element being processed, when the host renderer knows it. */
  sourceOffset?: number;
}

/**
 * A viewer plugin. `component` is deliberately typed loosely so this package can stay
 * React-free at runtime; the host narrows it.
 */
export interface ViewerPlugin<C = unknown> {
  manifest: ViewerManifest;
  /** Wrap in React.lazy so heavy deps land in their own chunk. */
  component: C;
  /** Reserved. The host does not yet contribute these into the parse pipeline. */
  remarkPlugins?: unknown[];
  /**
   * Reserved. **Not called yet.** The intent is a cheap tier that transforms the built-in
   * renderer's DOM instead of replacing the view (Mermaid, KaTeX). Declared so adding it later
   * is additive; implementing against it today does nothing.
   */
  postProcess?: (el: HTMLElement, ctx: PostProcessContext) => void | Promise<void>;
}

/** Identity helper that gives contributors inference and a stable call shape. */
export function defineViewer<C>(plugin: ViewerPlugin<C>): ViewerPlugin<C> {
  return plugin;
}

export const DEFAULT_RANK = 500;

export const BUILTIN_RANK = 100;

// ---------------------------------------------------------------------------
// Pure helpers. Kept here rather than in the host so both sides share exactly one
// implementation and cannot drift.
// ---------------------------------------------------------------------------

/** Byte-for-byte offset -> {line, column}, both 1-based, over LF-normalised text. */
export function offsetToLine(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/** Inverse of offsetToLine. Column is 1-based; out-of-range columns clamp to the line end. */
export function lineToOffset(text: string, line: number, column = 1): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const hardEnd = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(offset + column - 1, hardEnd);
}

/** Build a TextQuoteSelector with `context` characters of disambiguating prefix/suffix. */
export function quoteFor(text: string, range: SourceRange, context = 32): TextQuote {
  return {
    exact: text.slice(range.start, range.end),
    prefix: text.slice(Math.max(0, range.start - context), range.start),
    suffix: text.slice(range.end, Math.min(text.length, range.end + context)),
  };
}
