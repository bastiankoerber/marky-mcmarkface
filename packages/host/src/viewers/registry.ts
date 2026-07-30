import picomatch from 'picomatch';
import { DEFAULT_RANK, type ViewerPlugin, type ViewerManifest } from '@pilcrow/viewer-api';

/**
 * File path -> viewer resolution.
 *
 * Deliberately hand-written rather than built on tapable/hookable: the whole behaviour is a glob
 * match, a rank sort, and a user override, and a dependency would cost more to understand than
 * the code it replaced.
 *
 * Resolution rules, in order:
 *   1. A user override for this exact path wins outright, even over `priority: 'option'`.
 *   2. Otherwise only `priority: 'default'` viewers are candidates — an `'option'` viewer never
 *      opens on its own, matching VS Code's `customEditors` semantics.
 *   3. Lowest `rank` wins. Ties break on registration order, so a viewer registered earlier is
 *      preferred and resolution stays deterministic across runs.
 */

export interface RegisteredViewer {
  plugin: ViewerPlugin<unknown>;
  manifest: ViewerManifest;
  /** Registration index, used only to break rank ties deterministically. */
  order: number;
  matches: (path: string) => boolean;
}

export class ViewerRegistry {
  readonly #viewers = new Map<string, RegisteredViewer>();
  readonly #overrides = new Map<string, string>();
  #counter = 0;

  register(plugin: ViewerPlugin<unknown>): this {
    const { manifest } = plugin;
    if (this.#viewers.has(manifest.id)) {
      throw new Error(`duplicate viewer id: ${manifest.id}`);
    }
    if (manifest.selector.length === 0) {
      throw new Error(`viewer ${manifest.id} declares no selector and could never be resolved`);
    }

    const patterns = manifest.selector.map((s) => s.filenamePattern);
    const isMatch = picomatch(patterns, { dot: true });

    this.#viewers.set(manifest.id, {
      plugin,
      manifest,
      order: this.#counter++,
      // Match against the basename too, so a plugin can declare `*.md` without every contributor
      // having to remember to write `**/*.md`.
      matches: (path: string) => isMatch(path) || isMatch(basename(path)),
    });
    return this;
  }

  registerAll(plugins: Iterable<ViewerPlugin<unknown>>): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  get(id: string): RegisteredViewer | undefined {
    return this.#viewers.get(id);
  }

  all(): RegisteredViewer[] {
    return [...this.#viewers.values()];
  }

  /** Pin a specific viewer to a path. Pass null to clear. */
  setOverride(path: string, viewerId: string | null): void {
    if (viewerId === null) this.#overrides.delete(path);
    else this.#overrides.set(path, viewerId);
  }

  /** Every viewer that could open this path, best first. Drives the "open with" menu. */
  candidates(path: string): RegisteredViewer[] {
    return this.all()
      .filter((v) => v.matches(path))
      .sort(byRankThenOrder);
  }

  /** The viewer that should open this path, or undefined when nothing claims it. */
  resolve(path: string): RegisteredViewer | undefined {
    const pinned = this.#overrides.get(path);
    if (pinned) {
      const viewer = this.#viewers.get(pinned);
      if (viewer && viewer.matches(path)) return viewer;
    }
    return this.candidates(path).find((v) => (v.manifest.priority ?? 'default') === 'default');
  }
}

function rankOf(m: ViewerManifest): number {
  return m.rank ?? DEFAULT_RANK;
}

function byRankThenOrder(a: RegisteredViewer, b: RegisteredViewer): number {
  const diff = rankOf(a.manifest) - rankOf(b.manifest);
  return diff !== 0 ? diff : a.order - b.order;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
