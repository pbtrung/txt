import { describe, expect, it, vi } from "vitest";

import { R2AuthorizationError, type R2Client } from "../../src/data/r2";
import { R2Session } from "../../src/data/r2Session";
import type { ApiClient, R2CredentialSet } from "../../src/data/apiClient";
import type { OwnerSigningIdentity } from "../../src/data/ownerProof";

function credentials(expiresAt: number, suffix = "initial"): R2CredentialSet {
  const common = { secretAccessKey: "sk", sessionToken: "st" };
  return {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "bucket",
    expiresAt,
    documents: { ...common, accessKeyId: `documents-${suffix}` },
    catalog: { ...common, accessKeyId: `catalog-${suffix}` },
  };
}

function createSession(initial: R2CredentialSet, refreshed = initial) {
  const api = {
    fetchR2Credentials: vi.fn().mockResolvedValue(refreshed),
  } as unknown as ApiClient;
  const signing = {} as OwnerSigningIdentity;
  const session = new R2Session(api, signing, "p".repeat(52), initial);
  return { session, api };
}

function fakeClients(value: string) {
  return {
    documents: {
      getObject: vi.fn().mockResolvedValue(new TextEncoder().encode(value)),
      putImmutable: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Client,
    catalog: {
      getObject: vi.fn().mockResolvedValue(new TextEncoder().encode(value)),
    } as unknown as R2Client,
  };
}

const FAR_FUTURE = Math.floor(new Date("2099-01-01T00:00:00Z").getTime() / 1000);
const PAST = Math.floor(new Date("2000-01-01T00:00:00Z").getTime() / 1000);

describe("R2Session", () => {
  it("uses unexpired credentials without refreshing", async () => {
    const { session, api } = createSession(credentials(FAR_FUTURE));
    const clients = fakeClients("initial");
    (session as unknown as { clients: typeof clients }).clients = clients;

    const object = await session.getDocument("key");

    expect(new TextDecoder().decode(object!)).toBe("initial");
    expect(api.fetchR2Credentials).not.toHaveBeenCalled();
  });

  it("coalesces refreshes before the credential expiry", async () => {
    const refreshed = credentials(FAR_FUTURE, "refreshed");
    const { session, api } = createSession(credentials(PAST), refreshed);
    const clients = fakeClients("refreshed");
    (
      session as unknown as { buildClients: (pair: R2CredentialSet) => typeof clients }
    ).buildClients = vi.fn(() => clients);

    const [document, catalogObject] = await Promise.all([
      session.getDocument("documents/object"),
      session.getCatalogObject("catalog/object"),
    ]);

    expect(new TextDecoder().decode(document!)).toBe("refreshed");
    expect(new TextDecoder().decode(catalogObject!)).toBe("refreshed");
    expect(api.fetchR2Credentials).toHaveBeenCalledTimes(1);
  });

  it("forces one refresh and retries after R2 authorization fails", async () => {
    const { session, api } = createSession(
      credentials(FAR_FUTURE),
      credentials(FAR_FUTURE, "refreshed"),
    );
    const expiredClients = fakeClients("expired");
    vi.mocked(expiredClients.documents.getObject).mockRejectedValueOnce(
      new R2AuthorizationError("expired"),
    );
    const refreshedClients = fakeClients("refreshed");
    (session as unknown as { clients: typeof expiredClients }).clients = expiredClients;
    (
      session as unknown as {
        buildClients: (pair: R2CredentialSet) => typeof refreshedClients;
      }
    ).buildClients = vi.fn(() => refreshedClients);

    const content = await session.getDocument("documents/object");

    expect(new TextDecoder().decode(content!)).toBe("refreshed");
    expect(api.fetchR2Credentials).toHaveBeenCalledTimes(1);
  });

  it("refreshes credentials when the browser masks R2 rejection as fetch failure", async () => {
    const { session, api } = createSession(
      credentials(FAR_FUTURE),
      credentials(FAR_FUTURE, "refreshed"),
    );
    const staleClients = fakeClients("stale");
    vi.mocked(staleClients.documents.getObject).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const refreshedClients = fakeClients("refreshed");
    (session as unknown as { clients: typeof staleClients }).clients = staleClients;
    (
      session as unknown as {
        buildClients: (pair: R2CredentialSet) => typeof refreshedClients;
      }
    ).buildClients = vi.fn(() => refreshedClients);

    const content = await session.getDocument("documents/object");

    expect(new TextDecoder().decode(content!)).toBe("refreshed");
    expect(api.fetchR2Credentials).toHaveBeenCalledTimes(1);
  });

  it("retries credential refresh after connectivity is restored", async () => {
    vi.useFakeTimers();
    try {
      const refreshed = credentials(FAR_FUTURE, "refreshed");
      const { session, api } = createSession(credentials(PAST), refreshed);
      vi.mocked(api.fetchR2Credentials)
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(refreshed);
      const clients = fakeClients("refreshed");
      (
        session as unknown as {
          buildClients: (pair: R2CredentialSet) => typeof clients;
        }
      ).buildClients = vi.fn(() => clients);

      const contentPromise = session.getDocument("documents/object");
      await vi.advanceTimersByTimeAsync(250);

      await expect(contentPromise).resolves.toEqual(
        new TextEncoder().encode("refreshed"),
      );
      expect(api.fetchR2Credentials).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
