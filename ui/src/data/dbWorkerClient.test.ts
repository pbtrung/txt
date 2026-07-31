// @vitest-environment jsdom
//
// Exercises DbWorkerClient's request/response correlation logic (the actual
// non-trivial part of this file) against a fake Worker -- a minimal stub
// implementing postMessage/onmessage/terminate -- rather than a real
// dbWorker.ts instance, since that needs a genuine Worker environment
// Node/jsdom don't provide (see dbWorker.test.ts, which instead calls
// dbWorker.ts's own exported functions directly).

import { afterEach, describe, expect, it, vi } from "vitest";
import { DbWorkerClient } from "./dbWorkerClient";

interface PostedMessage {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

class FakeWorker {
  posted: PostedMessage[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  terminate = vi.fn();

  postMessage(msg: PostedMessage): void {
    this.posted.push(msg);
  }

  respond(id: number, ok: boolean, resultOrError: unknown): void {
    this.onmessage?.({
      data: ok
        ? { type: "result", id, ok, result: resultOrError }
        : { type: "result", id, ok, error: resultOrError },
    } as MessageEvent);
  }
}

let lastWorker: FakeWorker;

function installFakeWorker() {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        lastWorker = new FakeWorker();
        return lastWorker as unknown as Worker;
      }
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DbWorkerClient", () => {
  it("resolves a call with the worker's posted result", async () => {
    installFakeWorker();
    const client = new DbWorkerClient();
    const pending = client.partCount(7);

    expect(lastWorker.posted).toEqual([{ type: "call", id: 0, method: "partCount", args: [7] }]);
    lastWorker.respond(0, true, 3);

    expect(await pending).toBe(3);
  });

  it("rejects a call when the worker reports an error", async () => {
    installFakeWorker();
    const client = new DbWorkerClient();
    const pending = client.getTxtKey(1);

    lastWorker.respond(0, false, "no txt row for txt_id=1");

    await expect(pending).rejects.toThrow("no txt row for txt_id=1");
  });

  it("correlates multiple concurrent calls to their own responses, even answered out of order", async () => {
    installFakeWorker();
    const client = new DbWorkerClient();
    const first = client.partCount(1);
    const second = client.partCount(2);

    // Answer out of order -- id 1 (second call) before id 0 (first).
    lastWorker.respond(1, true, 20);
    lastWorker.respond(0, true, 10);

    expect(await first).toBe(10);
    expect(await second).toBe(20);
  });

  it("terminate() rejects every still-pending call and terminates the underlying worker", async () => {
    installFakeWorker();
    const client = new DbWorkerClient();
    const pending = client.partCount(1);

    client.terminate();

    await expect(pending).rejects.toThrow("db worker terminated");
    expect(lastWorker.terminate).toHaveBeenCalledOnce();
  });
});
