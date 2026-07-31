// Exercises RqliteHttpClient's commit() against a real local HTTP server --
// real fetch(), real JSON encode/decode -- focused on the correctness gap
// this used to have: commit() only ever checked results[1] (the CAS UPDATE),
// silently ignoring whether the guarded page INSERT (results[0]) actually
// inserted anything. If the INSERT errored or inserted fewer rows than
// expected while the UPDATE still won its own CAS check, db_meta's
// current_version would advance while the page content itself silently
// never landed. See txt/rqliteHttpClient.test.ts for the Node-side twin.

import { describe, expect, it } from "vitest";
import http from "node:http";
import { RqliteHttpClient, encodeBlobParam } from "./rqliteHttpClient";

interface CapturedRequest {
  url: string | undefined;
  body: any;
}

function startMockServer(respond: (req: CapturedRequest) => object): Promise<{
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const captured: CapturedRequest = {
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      };
      requests.push(captured);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond(captured)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("RqliteHttpClient.commit()", () => {
  it("posts ?transaction and reports a true CAS win only once both statements check out", async () => {
    const mock = await startMockServer((req) => ({
      results: [
        { rows_affected: req.body.commit.pages.length },
        { rows_affected: req.body.commit.old_version === 5 ? 1 : 0 },
      ],
    }));
    try {
      const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "key");
      const page = { pageNo: 3, data: new Uint8Array([1, 2, 3]) };
      const won = await client.commit([page], 5, 6, 10, "user-1");
      expect(won).toBe(true);
      expect(mock.requests[0]?.url).toBe("/db/execute?transaction");
    } finally {
      await mock.close();
    }
  });

  it("reports a CAS loss without throwing", async () => {
    const mock = await startMockServer(() => ({
      results: [{ rows_affected: 1 }, { rows_affected: 0 }],
    }));
    try {
      const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "key");
      const page = { pageNo: 3, data: new Uint8Array([1, 2, 3]) };
      const won = await client.commit([page], 999, 1000, 10);
      expect(won).toBe(false);
    } finally {
      await mock.close();
    }
  });

  it("throws with the real SQL error when the page INSERT itself fails, even though the UPDATE would have won", async () => {
    const mock = await startMockServer(() => ({
      results: [{ error: "UNIQUE constraint failed: pages.db_id, pages.page_no, pages.version" }],
    }));
    try {
      const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "key");
      const page = { pageNo: 3, data: new Uint8Array([1, 2, 3]) };
      await expect(client.commit([page], 5, 6, 10)).rejects.toThrow(
        /COMMIT page insert failed: UNIQUE constraint failed/,
      );
    } finally {
      await mock.close();
    }
  });

  it("throws if the CAS won but the insert quietly inserted the wrong number of rows", async () => {
    const mock = await startMockServer(() => ({
      results: [{ rows_affected: 0 }, { rows_affected: 1 }],
    }));
    try {
      const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "key");
      const page = { pageNo: 3, data: new Uint8Array([1, 2, 3]) };
      await expect(client.commit([page], 5, 6, 10)).rejects.toThrow(
        /COMMIT inserted 0 page row\(s\), expected 1/,
      );
    } finally {
      await mock.close();
    }
  });
});

describe("encodeBlobParam", () => {
  it("encodes as an x'...' hex literal, not a numeric byte array", () => {
    expect(encodeBlobParam(new Uint8Array([1, 2, 3]))).toBe("x'010203'");
    expect(encodeBlobParam(new Uint8Array([0, 255, 16]))).toBe("x'00ff10'");
    expect(encodeBlobParam(new Uint8Array([]))).toBe("x''");
  });
});
