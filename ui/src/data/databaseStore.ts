import type { CatalogCache } from "./libraryDb";
import { R2ConflictError } from "./r2";
import { R2Session } from "./r2Session";
import { ensureSchema } from "./schema";
import { SqliteDatabase } from "./sqlite";

const MAX_CONFLICT_ATTEMPTS = 3;

export interface DatabaseMutation {
  description: string;
  apply(db: SqliteDatabase): void;
}

export interface DatabaseStoreStatus {
  pending: boolean;
  unsaved: boolean;
  error: string | null;
}

export class LibraryDatabaseStore {
  // Lives for the store's whole session, surviving the internal db swaps
  // reload() below does on conflict resolution -- txt.catalog is write-once
  // and txt.id is never reused (docs/data_model.md §2.1), so a decoded
  // catalog is valid for as long as this store is, letting
  // useLibraryBooks skip re-decoding a book's catalog on every reload().
  readonly catalogCache: CatalogCache = new Map();
  private tail: Promise<void> = Promise.resolve();
  private failedMutations: DatabaseMutation[] = [];
  private listeners = new Set<() => void>();
  private status: DatabaseStoreStatus = {
    pending: false,
    unsaved: false,
    error: null,
  };
  private closing = false;
  private closed = false;

  private constructor(
    private readonly storage: R2Session,
    private readonly key: Uint8Array,
    private db: SqliteDatabase,
    private etag: string | null,
  ) {}

  static async open(
    storage: R2Session,
    key: Uint8Array,
  ): Promise<LibraryDatabaseStore> {
    const remote = await storage.getDatabase();
    const db = remote
      ? await SqliteDatabase.openKeyed(key, remote.bytes)
      : await SqliteDatabase.openKeyed(key);
    try {
      ensureSchema(db);
      return new LibraryDatabaseStore(storage, key, db, remote?.etag ?? null);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  read<T>(reader: (db: SqliteDatabase) => Promise<T>): Promise<T>;
  read<T>(reader: (db: SqliteDatabase) => T): Promise<T>;
  read<T>(reader: (db: SqliteDatabase) => T | Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("database is closed"));
    }
    const operation = this.tail.then(async () => {
      if (this.closed) throw new Error("database is closed");
      return await reader(this.db);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  mutate(mutation: DatabaseMutation): Promise<void> {
    return this.enqueue(mutation);
  }

  retry(): Promise<void> {
    if (this.failedMutations.length === 0) return Promise.resolve();
    return this.enqueue(null);
  }

  snapshot(): DatabaseStoreStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await this.tail;
    this.db.close();
    this.closed = true;
    this.emit({ pending: false, unsaved: false, error: null });
  }

  private enqueue(mutation: DatabaseMutation | null): Promise<void> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("database is closed"));
    const operation = this.tail.then(async () => {
      const mutations = [...this.failedMutations];
      if (mutation) mutations.push(mutation);
      if (mutations.length === 0) return;
      await this.persist(mutations);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async persist(mutations: DatabaseMutation[]): Promise<void> {
    this.emit({ pending: true, unsaved: true, error: null });
    for (let attempt = 1; attempt <= MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      let mutationApplied = false;
      try {
        this.db.transaction(() => {
          for (const mutation of mutations) mutation.apply(this.db);
        });
        mutationApplied = true;
        this.etag = await this.storage.putDatabase(this.db.toBytes(), this.etag);
        this.failedMutations = [];
        this.emit({ pending: false, unsaved: false, error: null });
        return;
      } catch (error) {
        if (error instanceof R2ConflictError && attempt < MAX_CONFLICT_ATTEMPTS) {
          try {
            await this.reload();
            continue;
          } catch {
            // Reload failed too; fall through to the same failure handling
            // as any other persist failure instead of leaking this reload
            // error unhandled and leaving status stuck at pending.
          }
        }
        if (mutationApplied) this.failedMutations = mutations;
        await this.reloadAfterFailure();
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          pending: false,
          unsaved: this.failedMutations.length > 0,
          error: message,
        });
        throw error;
      }
    }
  }

  private async reloadAfterFailure(): Promise<void> {
    try {
      await this.reload();
    } catch {
      // A later retry will attempt the reload again; retain the failed semantic
      // mutations rather than claiming that they were saved.
    }
  }

  private async reload(): Promise<void> {
    const remote = await this.storage.getDatabase();
    const replacement = remote
      ? await SqliteDatabase.openKeyed(this.key, remote.bytes)
      : await SqliteDatabase.openKeyed(this.key);
    try {
      ensureSchema(replacement);
    } catch (error) {
      replacement.close();
      throw error;
    }
    const previous = this.db;
    this.db = replacement;
    this.etag = remote?.etag ?? null;
    previous.close();
  }

  private emit(status: DatabaseStoreStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
