import { GitHubClient } from './github/client.js';
import { fetchDashboard, type DashboardData } from './github/dashboard.js';

/**
 * The server owns all polling; the browser never talks to GitHub.
 *
 * Without this, N open tabs multiply GitHub traffic by N — a real hazard for a localhost app
 * people leave open. One poller, one cache, and the UI is pushed updates over SSE.
 *
 * Budget: the dashboard query costs 1 point. At 60s while focused that is ~60 points/hour
 * against 5,000, under 2%.
 */

export type Listener = (event: string, data: unknown) => void;

const FOCUSED_MS = 60_000;
const BLURRED_MS = 5 * 60_000;
const IDLE_AFTER_MS = 30 * 60_000;

export class Poller {
  #client: GitHubClient | null = null;
  #timer: NodeJS.Timeout | null = null;
  #listeners = new Set<Listener>();
  #data: DashboardData | null = null;
  #error: string | null = null;
  #lastActivity = Date.now();
  #focused = true;
  #inFlight: Promise<void> | null = null;

  setClient(client: GitHubClient | null): void {
    this.#client = client;
    this.#data = null;
    this.#error = null;
    if (client) void this.refresh();
    this.#schedule();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    if (this.#data) listener('dashboard', this.#data);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: string, data: unknown): void {
    for (const l of this.#listeners) {
      try {
        l(event, data);
      } catch {
        /* a dead SSE connection must not stop the others */
      }
    }
  }

  get snapshot(): { data: DashboardData | null; error: string | null } {
    return { data: this.#data, error: this.#error };
  }

  setFocus(focused: boolean): void {
    this.#focused = focused;
    if (focused) this.#lastActivity = Date.now();
    this.#schedule();
  }

  #interval(): number | null {
    if (!this.#client) return null;
    if (Date.now() - this.#lastActivity > IDLE_AFTER_MS) return null; // fully idle: stop polling
    return this.#focused ? FOCUSED_MS : BLURRED_MS;
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const ms = this.#interval();
    if (ms === null) return;
    this.#timer = setTimeout(() => void this.refresh(), ms);
    this.#timer.unref?.();
  }

  /** Coalesces concurrent callers onto one in-flight request. */
  async refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const client = this.#client;
    if (!client) return;

    if (client.blockedUntil > Date.now()) {
      this.#error = `GitHub rate limit reached. Syncing paused until ${new Date(client.blockedUntil).toLocaleTimeString()}.`;
      this.#emit('error', { message: this.#error });
      this.#schedule();
      return;
    }

    this.#inFlight = (async () => {
      try {
        this.#data = await fetchDashboard(client);
        this.#error = null;
        this.#emit('dashboard', this.#data);
      } catch (err) {
        this.#error = (err as Error).message;
        this.#emit('error', { message: this.#error });
      } finally {
        this.#inFlight = null;
        this.#schedule();
      }
    })();

    return this.#inFlight;
  }

  emit(event: string, data: unknown): void {
    this.#emit(event, data);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
