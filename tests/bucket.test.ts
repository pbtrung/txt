import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
}));

function b64(text: string): string {
  return Buffer.from(text, "ascii").toString("base64");
}

const R2_CONFIG_PAYLOAD = {
  r2_config: {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "my-bucket",
    read_only_access_key_id: "ro-id",
    read_only_secret_access_key: "ro-secret",
    read_write_access_key_id: "rw-id",
    read_write_secret_access_key: "rw-secret",
  },
};

vi.mock("@instantdb/admin", () => ({
  init: () => ({ query: state.query }),
}));

// Identity crypto: "encrypt"/"decrypt" are no-ops that just hand back the
// buffer they were given -- this suite is about bucket.ts's own known-path
// computation (owned txt rows *and* sharedTxt rows), not re-verifying the
// real AEAD.
vi.mock("../txt/crypto.ts", () => ({
  CryptoEngine: {
    create: async () => ({
      blobDecrypt: (_ikm: unknown, blob: Buffer) => blob,
    }),
  },
}));

const listAllObjects = vi.fn();
const deleteObjects = vi.fn();
vi.mock("../txt/r2.ts", () => ({
  R2Client: class {
    async listAllObjects() {
      return listAllObjects();
    }
    async deleteObjects(keys: string[]) {
      return deleteObjects(keys);
    }
  },
}));

import type { Logger } from "../txt/logger.ts";
import type { ScanCreds } from "../txt/scanCreds.ts";
import { TxtBucketCleaner } from "../txt/bucket.ts";

const creds: ScanCreds = {
  instantAppId: "app-1",
  instantAdminToken: "admin-token",
  userRootKey: Buffer.from("root-key"),
};

const log: Logger = {
  verbose: true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function queryHandler(query: any): unknown {
  if (query.$users) {
    return { $users: [{ id: "admin-1", umk: b64("admin-umk") }] };
  }
  if (query.credStore) {
    return {
      credStore: [
        {
          credStoreKey: b64("admin-credstore-key"),
          content: b64(JSON.stringify(R2_CONFIG_PAYLOAD)),
        },
      ],
    };
  }
  if (query.txt) {
    if (query.txt.$.offset > 0) return { txt: [] };
    return {
      txt: [
        {
          id: "txt-1",
          txtKey: b64("txt-key-1"),
          prefix: b64("owned-prefix"),
          txtParts: [
            { txtPartKey: b64("owned-partkey-1"), path: b64("owned-rawkey-1") },
          ],
        },
      ],
    };
  }
  if (query.sharedTxt) {
    if (query.sharedTxt.$.offset > 0) return { sharedTxt: [] };
    return {
      sharedTxt: [
        {
          id: "share-1",
          adminTxtKey: b64("shared-root-key"),
          prefix: b64("shared-prefix"),
          sharedTxtParts: [
            {
              txtPartKey: b64("shared-partkey-1"),
              path: b64("shared-rawkey-1"),
            },
          ],
        },
      ],
    };
  }
  return {};
}

describe("TxtBucketCleaner", () => {
  it("treats both an owned document's and a share's own R2 objects as known, flagging only the true orphan", async () => {
    state.query.mockImplementation(async (q) => queryHandler(q));
    listAllObjects.mockResolvedValue([
      { key: "owned-prefix/owned-rawkey-1", size: 10 },
      { key: "shared-prefix/shared-rawkey-1", size: 20 },
      { key: "orphan-prefix/orphan-key", size: 30 },
    ]);

    const cleaner = new TxtBucketCleaner(creds, log);
    const { stats, orphans } = await cleaner.clean({
      dryRun: true,
      confirm: async () => true,
    });

    expect(orphans.map((o) => o.key)).toEqual(["orphan-prefix/orphan-key"]);
    expect(stats.txtCount).toBe(1);
    expect(stats.sharedCount).toBe(1);
    expect(stats.totalKnownPaths).toBe(2);
    expect(stats.totalObjects).toBe(3);
    expect(stats.orphanCount).toBe(1);
    // Dry run: never lists a delete, even with a real orphan present.
    expect(deleteObjects).not.toHaveBeenCalled();
  });
});
