import { base64url } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { storagePathBinding } from "../../shared/r2Proof";
import { getAccount } from "../account";
import { verifyFirebaseIdToken } from "../firebaseAuth";
import {
  handleCreateShareGrant,
  handleDeleteShare,
  handleSharedContent,
} from "../share";

vi.mock("../account");
vi.mock("../firebaseAuth");

const ADMIN_UID = "admin-uid";
const DB_PATH = "0".repeat(52);
const DB_PREFIX = "1".repeat(52);
const SHARE_PREFIX = "2".repeat(52);
const SHARE_PATH = "3".repeat(52);
const SHARE_ID_BYTES = new Uint8Array(32).fill(4);
const SHARE_ID = toBase64(SHARE_ID_BYTES);
const ENV = {
  ADMIN_UID,
  FIREBASE_PROJECT_ID: "project",
  R2_TICKET_SECRET: toBase64(new Uint8Array(32).fill(5)),
  SHARE_GRANT_KEY: toBase64(new Uint8Array(32).fill(6)),
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET: "bucket",
  R2_REGION: "auto",
  R2_READ_WRITE_ACCESS_KEY_ID: "access",
  R2_READ_WRITE_SECRET_ACCESS_KEY: "secret",
  SHARE_REGISTRY: {},
} as unknown as Env;

beforeEach(async () => {
  vi.resetAllMocks();
  (ENV as unknown as { SHARE_REGISTRY: D1Database }).SHARE_REGISTRY =
    new FakeD1() as unknown as D1Database;
  vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: ADMIN_UID });
  vi.mocked(getAccount).mockResolvedValue({
    status: "ok",
    account: {
      type: "user",
      umk: "",
      signVersion: 1,
      signAlgorithm: "ECDSA-P521-SHA512",
      signPublicKey: "",
      signPrivateKey: "",
      userHandleHash: toBase64(new Uint8Array(32)),
      dbBindingHash: toBase64(await storagePathBinding(DB_PATH, DB_PREFIX)),
      credStoreContent: "",
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))),
  );
});

describe("D1-backed book shares", () => {
  it("registers only ADMIN_UID and keeps the object path opaque", async () => {
    const response = await handleCreateShareGrant(createRequest(), ENV);
    expect(response.status).toBe(200);
    const { grant } = (await response.json()) as { grant: string };
    expect(new TextDecoder().decode(base64url.decode(grant))).not.toContain(DB_PREFIX);
    const repeated = await handleCreateShareGrant(createRequest(), ENV);
    expect(((await repeated.json()) as { grant: string }).grant).not.toBe(grant);
    const registry = ENV.SHARE_REGISTRY as unknown as FakeD1;
    expect(registry.rows.size).toBe(1);
    expect([...registry.rows.values()][0].object_path_hash.byteLength).toBe(32);

    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "other" });
    expect((await handleCreateShareGrant(createRequest(), ENV)).status).toBe(403);
  });

  it("proxies encrypted content only while the D1 row exists", async () => {
    const { grant } = (await (
      await handleCreateShareGrant(createRequest(), ENV)
    ).json()) as { grant: string };
    const active = await handleSharedContent(contentRequest(grant), ENV);
    expect(active.status).toBe(200);
    expect(new Uint8Array(await active.arrayBuffer())).toEqual(
      new Uint8Array([7, 8, 9]),
    );

    expect((await handleDeleteShare(deleteRequest(), ENV)).status).toBe(204);
    const r2Delete = vi.mocked(fetch).mock.calls.at(-1)?.[0] as Request;
    expect(r2Delete.url).toBe(
      `${ENV.R2_ENDPOINT}/${ENV.R2_BUCKET}/${DB_PREFIX}/shared/${SHARE_PREFIX}/${SHARE_PATH}`,
    );
    expect(r2Delete.method).toBe("DELETE");
    expect((await handleSharedContent(contentRequest(grant), ENV)).status).toBe(404);
  });

  it("keeps the registry row when R2 deletion fails", async () => {
    await handleCreateShareGrant(createRequest(), ENV);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    expect((await handleDeleteShare(deleteRequest(), ENV)).status).toBe(503);
    expect((ENV.SHARE_REGISTRY as unknown as FakeD1).rows.size).toBe(1);
  });

  it("rejects path changes and moved grants, then permits registration after delete", async () => {
    expect(
      (await handleCreateShareGrant(createRequest({ db_prefix: "9".repeat(52) }), ENV))
        .status,
    ).toBe(403);
    const { grant } = (await (
      await handleCreateShareGrant(createRequest(), ENV)
    ).json()) as { grant: string };
    const otherId = base64url.encode(new Uint8Array(32).fill(8));
    expect(
      (await handleSharedContent(contentRequest(grant, otherId), ENV)).status,
    ).toBe(404);
    await handleDeleteShare(deleteRequest(), ENV);
    expect((await handleCreateShareGrant(createRequest(), ENV)).status).toBe(200);
  });
});

class FakeD1 {
  rows = new Map<string, { object_path_hash: ArrayBuffer }>();

  prepare(sql: string) {
    let values: unknown[] = [];
    return {
      bind: (...next: unknown[]) => {
        values = next;
        return this.statement(sql, () => values);
      },
    };
  }

  private statement(sql: string, values: () => unknown[]) {
    return {
      run: async () => {
        const args = values();
        const key = hex(args[0]);
        if (sql.startsWith("INSERT") && !this.rows.has(key)) {
          this.rows.set(key, {
            object_path_hash: buffer(args[1]),
          });
        } else if (sql.startsWith("DELETE")) {
          this.rows.delete(key);
        }
        return { success: true };
      },
      first: async <T>() => {
        const row = this.rows.get(hex(values()[0]));
        return (row ?? null) as T | null;
      },
    };
  }
}

function createRequest(overrides: Record<string, string> = {}): Request {
  return jsonRequest("POST", "/v1/share-grant", {
    db_path: DB_PATH,
    db_prefix: DB_PREFIX,
    share_prefix: SHARE_PREFIX,
    share_path: SHARE_PATH,
    share_id: SHARE_ID,
    ...overrides,
  });
}

function deleteRequest(): Request {
  return jsonRequest("DELETE", "/v1/share", {
    db_path: DB_PATH,
    db_prefix: DB_PREFIX,
    share_prefix: SHARE_PREFIX,
    share_path: SHARE_PATH,
    share_id: SHARE_ID,
  });
}

function contentRequest(
  grant: string,
  shareId = base64url.encode(SHARE_ID_BYTES),
): Request {
  return jsonRequest("POST", "/v1/shared-content", { share_id: shareId, grant });
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`https://example${path}`, {
    method,
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buffer(value: unknown): ArrayBuffer {
  const bytes = value as Uint8Array;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function hex(value: unknown): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return [...(bytes as Uint8Array)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
