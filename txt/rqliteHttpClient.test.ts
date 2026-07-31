// Exercises RqliteHttpClient against a real local HTTP server -- real
// fetch(), real JSON encode/decode, real Authorization header -- everything
// except the actual remote deployment. This deliberately never involves a
// worker thread or Atomics: it's the same request/response logic
// remotePageWorker.ts uses internally, verified here from the main thread
// where plain async fetch() is unaffected by the sandbox limitation noted
// in remoteVfs.test.ts / testPerf.ts's worker+Atomics bridge.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  RqliteHttpClient,
  resultRows,
  decodeBlobColumn,
  type RqliteResult,
} from "./rqliteHttpClient.ts";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  auth: string | undefined;
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
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
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

test("RqliteHttpClient.query: posts the {statementId,batch} envelope with Bearer auth", async () => {
  const mock = await startMockServer(() => ({
    results: [{ columns: ["page_no"], values: [[1]] }],
  }));
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "my-api-key");
    const results = await client.query("READ_PAGE", [{ page_no: 3, snapshot: 42 }]);

    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.method, "POST");
    assert.equal(mock.requests[0]?.url, "/db/query");
    assert.equal(mock.requests[0]?.auth, "Bearer my-api-key");
    assert.deepEqual(mock.requests[0]?.body, {
      statementId: "READ_PAGE",
      batch: [{ page_no: 3, snapshot: 42 }],
    });
    assert.deepEqual(results, [{ columns: ["page_no"], values: [[1]] }]);
  } finally {
    await mock.close();
  }
});

test("RqliteHttpClient.execute: posts to /db/execute and merges extra fields", async () => {
  const mock = await startMockServer(() => ({ results: [{}] }));
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}/`, "key");
    await client.execute("REVOKE_KEY", [{}], { target_db_id: "user-1" });

    assert.equal(mock.requests[0]?.url, "/db/execute");
    assert.deepEqual(mock.requests[0]?.body, {
      statementId: "REVOKE_KEY",
      batch: [{}],
      target_db_id: "user-1",
    });
  } finally {
    await mock.close();
  }
});

test("RqliteHttpClient: records one roundtrip stat per call, and strips a trailing slash from baseUrl", async () => {
  const mock = await startMockServer(() => ({ results: [{}] }));
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}///`, "key");
    await client.query("GET_META", [{}]);
    await client.query("GET_META", [{}]);

    assert.equal(client.roundtrips.length, 2);
    for (const rt of client.roundtrips) {
      assert.equal(rt.label, "GET_META");
      assert.ok(rt.ms >= 0);
    }
    assert.equal(mock.requests[0]?.url, "/db/query");
  } finally {
    await mock.close();
  }
});

test("RqliteHttpClient: throws on a non-2xx HTTP status", async () => {
  const server = http.createServer((_req, res) => res.writeHead(500).end("boom"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${port}`, "key");
    await assert.rejects(client.query("GET_META", [{}]), /HTTP 500/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("RqliteHttpClient: throws on a response missing 'results'", async () => {
  const mock = await startMockServer(() => ({ ok: true }));
  try {
    const client = new RqliteHttpClient(`http://127.0.0.1:${mock.port}`, "key");
    await assert.rejects(client.query("GET_META", [{}]), /malformed response/);
  } finally {
    await mock.close();
  }
});

test("resultRows: returns values, throws on a per-statement error, defaults to []", () => {
  const ok: RqliteResult[] = [{ values: [[1, 2]] }];
  assert.deepEqual(resultRows(ok), [[1, 2]]);

  const noValues: RqliteResult[] = [{}];
  assert.deepEqual(resultRows(noValues), []);

  const errored: RqliteResult[] = [{ error: "no such table: users" }];
  assert.throws(() => resultRows(errored), /no such table: users/);

  assert.throws(() => resultRows([], 0), /missing result\[0\]/);
});

test("decodeBlobColumn: decodes base64, rejects non-string values", () => {
  const original = Buffer.from("page ciphertext");
  assert.deepEqual(decodeBlobColumn(original.toString("base64")), original);
  assert.throws(() => decodeBlobColumn(42), /expected base64 blob string/);
});
