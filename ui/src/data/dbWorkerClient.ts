// Main-thread wrapper around dbWorker.ts -- the only thing that talks to
// that Worker directly. Every method here is a plain async RPC call
// (postMessage a {id, method, args}, resolve/reject the matching promise
// once the worker posts back {id, ok, result | error}); nothing about
// SqliteDb/the lazy VFS/commit state is ever visible on the main thread
// anymore -- see dbWorker.ts's own header comment for why it all had to
// move into a Worker in the first place.

interface RpcResult {
  type: "result";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class DbWorkerClient {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./dbWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<RpcResult>) => {
      const { id, ok, result, error } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "call", id, method, args });
    });
  }

  open(creds: { rqliteUrl: string; apiKey: string; userRootKey: Uint8Array }): Promise<void> {
    return this.call("open", creds);
  }

  refresh(): Promise<void> {
    return this.call("refresh");
  }

  getTxtKey(txtId: number): Promise<Uint8Array> {
    return this.call("getTxtKey", txtId);
  }

  getR2Config(): Promise<import("./r2Config").R2Config> {
    return this.call("getR2Config");
  }

  loadLibrary(): Promise<import("./library").LibrarySnapshot> {
    return this.call("loadLibrary");
  }

  loadBookmarksMap(): Promise<import("./bookmarks").BookmarksMap> {
    return this.call("loadBookmarksMap");
  }

  recordReadPosition(txtId: number, position: import("./access").ReadPosition): Promise<void> {
    return this.call("recordReadPosition", txtId, position);
  }

  removeAccessEntry(txtId: number): Promise<void> {
    return this.call("removeAccessEntry", txtId);
  }

  addBookmarkEntry(
    txtId: number,
    partNum: number,
    line: number,
    preview: string,
    createdAt: number,
  ): Promise<import("./bookmarks").BookmarksMap> {
    return this.call("addBookmarkEntry", txtId, partNum, line, preview, createdAt);
  }

  removeBookmarkEntry(bookmarkId: number): Promise<import("./bookmarks").BookmarksMap> {
    return this.call("removeBookmarkEntry", bookmarkId);
  }

  partCount(txtId: number): Promise<number> {
    return this.call("partCount", txtId);
  }

  partRawPath(txtId: number, partNum: number): Promise<string | null> {
    return this.call("partRawPath", txtId, partNum);
  }

  /** Terminates the worker (and, inside it, the nested page-fetch worker +
   * the open SqliteDb) -- call this on lock(), and before opening a
   * replacement client on refresh(). */
  terminate(): void {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(new Error("db worker terminated"));
    this.pending.clear();
  }
}
