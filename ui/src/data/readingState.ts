// The reading-position timing state machine: a grace period before a
// position first counts as "visited", debounced/throttled saves after
// that. Bookmark and reading-position persistence itself lives in
// LibraryStore -- this only decides when to call it.
import type { LibraryStore } from "./libraryStore";

const GRACE_MS = 6_000;
const LOCATION_DEBOUNCE_MS = 2_000;
const UPLOAD_INTERVAL_MS = 15_000;

interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class ReadingSession {
  private candidateCfi: string | null = null;
  private lastSubmittedCfi: string | null = null;
  private graceRemaining = GRACE_MS;
  private graceStartedAt = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private qualified = false;
  private visible = false;
  private dirty = false;
  private disposed = false;
  private lastDispatchedAt = Number.NEGATIVE_INFINITY;
  private onError: ((error: unknown) => void) | null = null;

  constructor(
    private readonly library: Pick<LibraryStore, "updateReadingPosition">,
    private readonly txtId: number,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  start(initialCfi: string | null, visible: boolean): void {
    if (this.disposed) return;
    this.candidateCfi = initialCfi;
    this.visible = visible;
    if (visible) this.armGrace();
  }

  relocate(cfi: string, userInitiated: boolean): void {
    if (this.disposed) return;
    this.candidateCfi = cfi;
    if (!this.qualified || !userInitiated) return;
    this.dirty = cfi !== this.lastSubmittedCfi;
    if (!this.dirty) return;
    this.clearTimer("debounce");
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.flushThrottled();
    }, LOCATION_DEBOUNCE_MS);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (!this.qualified) {
      if (visible) this.armGrace();
      else this.pauseGrace();
    } else if (!visible) {
      this.flushNow();
    }
  }

  /** Re-attempts saving the current position after a previous save failed. */
  retry(): void {
    if (!this.qualified || this.disposed) return;
    this.dirty = true;
    this.flushNow();
  }

  onSaveError(callback: (error: unknown) => void): void {
    this.onError = callback;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.qualified) this.flushNow();
    this.disposed = true;
    this.clearTimer("grace");
    this.clearTimer("debounce");
    this.clearTimer("throttle");
  }

  private armGrace(): void {
    if (this.qualified || this.graceTimer || this.graceRemaining <= 0) return;
    this.graceStartedAt = this.clock.now();
    this.graceTimer = this.clock.setTimeout(() => {
      this.graceTimer = null;
      this.graceRemaining = 0;
      this.qualify();
    }, this.graceRemaining);
  }

  private pauseGrace(): void {
    if (!this.graceTimer) return;
    this.graceRemaining = Math.max(
      0,
      this.graceRemaining - (this.clock.now() - this.graceStartedAt),
    );
    this.clearTimer("grace");
  }

  private qualify(): void {
    if (this.disposed || this.qualified) return;
    this.qualified = true;
    this.dirty = true;
    this.dispatch(true);
  }

  private flushThrottled(): void {
    if (!this.dirty || this.disposed) return;
    const wait = UPLOAD_INTERVAL_MS - (this.clock.now() - this.lastDispatchedAt);
    if (wait <= 0) {
      this.dispatch(false);
      return;
    }
    if (!this.throttleTimer) {
      this.throttleTimer = this.clock.setTimeout(() => {
        this.throttleTimer = null;
        this.flushThrottled();
      }, wait);
    }
  }

  private flushNow(): void {
    if (!this.dirty) return;
    this.clearTimer("debounce");
    this.clearTimer("throttle");
    this.dispatch(false);
  }

  private dispatch(includeLastAccessed: boolean): void {
    const cfi = this.candidateCfi;
    const now = this.clock.now();
    this.lastDispatchedAt = now;
    this.lastSubmittedCfi = cfi;
    this.dirty = false;
    void this.library
      .updateReadingPosition(this.txtId, cfi, includeLastAccessed ? now : null)
      .catch((error: unknown) => this.onError?.(error));
  }

  private clearTimer(kind: "grace" | "debounce" | "throttle"): void {
    const key = `${kind}Timer` as const;
    const timer = this[key];
    if (timer) this.clock.clearTimeout(timer);
    this[key] = null;
  }
}
