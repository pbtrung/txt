import type { DatabaseMutation, LibraryDatabaseStore } from "./databaseStore";

const GRACE_MS = 6_000;
const LOCATION_DEBOUNCE_MS = 2_000;
const UPLOAD_INTERVAL_MS = 15_000;
const PREVIEW_BYTES = 100;

export interface BookmarkRecord {
  id: number;
  cfi: string;
  preview: string;
  createdAt: number;
}

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

  constructor(
    private readonly database: Pick<LibraryDatabaseStore, "mutate">,
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
    void this.database
      .mutate(readingMutation(this.txtId, cfi, includeLastAccessed ? now : null))
      .catch(() => {
        // LibraryDatabaseStore exposes the retained unsaved mutation and error.
      });
  }

  private clearTimer(kind: "grace" | "debounce" | "throttle"): void {
    const key = `${kind}Timer` as const;
    const timer = this[key];
    if (timer) this.clock.clearTimeout(timer);
    this[key] = null;
  }
}

export async function listBookmarks(
  database: LibraryDatabaseStore,
  txtId: number,
): Promise<BookmarkRecord[]> {
  return database.read((db) =>
    db
      .query(
        "SELECT id, cfi, preview, created_at FROM txt_bookmarks " +
          "WHERE txt_id = ? ORDER BY created_at DESC, id DESC",
        [txtId],
      )
      .map(([id, cfi, preview, createdAt]) => ({
        id: id as number,
        cfi: cfi as string,
        preview: preview as string,
        createdAt: createdAt as number,
      })),
  );
}

export function saveBookmarkMutation(
  txtId: number,
  cfi: string,
  preview: string,
  createdAt = Date.now(),
): DatabaseMutation {
  const safePreview = truncateUtf8(normalizePreview(preview), PREVIEW_BYTES);
  return {
    description: "save bookmark",
    apply: (db) =>
      db.execute(
        "INSERT INTO txt_bookmarks (txt_id, cfi, preview, created_at) " +
          "VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(txt_id, cfi) DO UPDATE SET " +
          "preview = excluded.preview, created_at = excluded.created_at",
        [txtId, cfi, safePreview, createdAt],
      ),
  };
}

export function deleteBookmarkMutation(txtId: number, cfi: string): DatabaseMutation {
  return {
    description: "delete bookmark",
    apply: (db) =>
      db.execute("DELETE FROM txt_bookmarks WHERE txt_id = ? AND cfi = ?", [
        txtId,
        cfi,
      ]),
  };
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (used + size > maximumBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readingMutation(
  txtId: number,
  cfi: string | null,
  lastAccessed: number | null,
): DatabaseMutation {
  return {
    description: "save reading position",
    apply: (db) => {
      if (lastAccessed !== null) {
        db.execute("UPDATE txt SET last_accessed = ?, last_cfi = ? WHERE id = ?", [
          lastAccessed,
          cfi,
          txtId,
        ]);
      } else if (cfi !== null) {
        db.execute("UPDATE txt SET last_cfi = ? WHERE id = ?", [cfi, txtId]);
      }
    },
  };
}
