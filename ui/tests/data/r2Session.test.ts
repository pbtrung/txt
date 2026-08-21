import { describe, expect, it, vi } from "vitest";

import { R2AuthorizationError, type R2Client } from "../../src/data/r2";
import { R2Session } from "../../src/data/r2Session";
import type {
  ApiClient,
  R2CredentialPair,
  R2SigningIdentity,
} from "../../src/data/apiClient";

function credentials(expiration: string, suffix = "initial"): R2CredentialPair {
  const common = {
    secretAccessKey: "sk",
    sessionToken: "st",
    expiration,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "bucket",
    region: "auto",
  };
  return {
    dbPath: { ...common, accessKeyId: `db-${suffix}` },
    dbPrefix: { ...common, accessKeyId: `prefix-${suffix}` },
  };
}

function createSession(initial: R2CredentialPair, refreshed = initial) {
  const api = {
    fetchR2Token: vi.fn().mockResolvedValue(refreshed),
  } as unknown as ApiClient;
  const signing = {} as R2SigningIdentity;
  const session = new R2Session(api, signing, "d".repeat(52), "p".repeat(52), initial);
  return { session, api };
}

function fakeClients(value: string) {
  return {
    dbPath: {
      getDatabase: vi.fn().mockResolvedValue({
        bytes: new TextEncoder().encode(value),
        etag: `"${value}"`,
      }),
      putDatabase: vi.fn().mockResolvedValue(`"${value}"`),
    } as unknown as R2Client,
    dbPrefix: {
      getObject: vi.fn().mockResolvedValue(new TextEncoder().encode(value)),
    } as unknown as R2Client,
  };
}

describe("R2Session", () => {
  it("uses unexpired credentials without refreshing", async () => {
    const { session, api } = createSession(credentials("2099-01-01T00:00:00Z"));
    const clients = fakeClients("initial");
    (session as unknown as { clients: typeof clients }).clients = clients;

    const object = await session.getDatabase();

    expect(new TextDecoder().decode(object!.bytes)).toBe("initial");
    expect(api.fetchR2Token).not.toHaveBeenCalled();
  });

  it("coalesces refreshes before the credential expiry", async () => {
    const refreshed = credentials("2099-01-01T00:00:00Z", "refreshed");
    const { session, api } = createSession(
      credentials("2000-01-01T00:00:00Z"),
      refreshed,
    );
    const clients = fakeClients("refreshed");
    (
      session as unknown as {
        buildClients: (pair: R2CredentialPair) => typeof clients;
      }
    ).buildClients = vi.fn(() => clients);

    const [database, content] = await Promise.all([
      session.getDatabase(),
      session.getContent("p".repeat(52) + "/object"),
    ]);

    expect(new TextDecoder().decode(database!.bytes)).toBe("refreshed");
    expect(new TextDecoder().decode(content!)).toBe("refreshed");
    expect(api.fetchR2Token).toHaveBeenCalledTimes(1);
  });

  it("forces one refresh and retries after R2 authorization fails", async () => {
    const { session, api } = createSession(
      credentials("2099-01-01T00:00:00Z"),
      credentials("2099-01-01T00:00:00Z", "refreshed"),
    );
    const expiredClients = fakeClients("expired");
    vi.mocked(expiredClients.dbPrefix.getObject).mockRejectedValueOnce(
      new R2AuthorizationError("expired"),
    );
    const refreshedClients = fakeClients("refreshed");
    (session as unknown as { clients: typeof expiredClients }).clients = expiredClients;
    (
      session as unknown as {
        buildClients: (pair: R2CredentialPair) => typeof refreshedClients;
      }
    ).buildClients = vi.fn(() => refreshedClients);

    const content = await session.getContent("p".repeat(52) + "/object");

    expect(new TextDecoder().decode(content!)).toBe("refreshed");
    expect(api.fetchR2Token).toHaveBeenCalledTimes(1);
  });

  it("refreshes credentials when the browser masks R2 rejection as fetch failure", async () => {
    const { session, api } = createSession(
      credentials("2099-01-01T00:00:00Z"),
      credentials("2099-01-01T00:00:00Z", "refreshed"),
    );
    const staleClients = fakeClients("stale");
    vi.mocked(staleClients.dbPrefix.getObject).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const refreshedClients = fakeClients("refreshed");
    (session as unknown as { clients: typeof staleClients }).clients = staleClients;
    (
      session as unknown as {
        buildClients: (pair: R2CredentialPair) => typeof refreshedClients;
      }
    ).buildClients = vi.fn(() => refreshedClients);

    const content = await session.getContent("p".repeat(52) + "/object");

    expect(new TextDecoder().decode(content!)).toBe("refreshed");
    expect(api.fetchR2Token).toHaveBeenCalledTimes(1);
  });

  it("retries credential refresh after connectivity is restored", async () => {
    vi.useFakeTimers();
    try {
      const refreshed = credentials("2099-01-01T00:00:00Z", "refreshed");
      const { session, api } = createSession(
        credentials("2000-01-01T00:00:00Z"),
        refreshed,
      );
      vi.mocked(api.fetchR2Token)
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(refreshed);
      const clients = fakeClients("refreshed");
      (
        session as unknown as {
          buildClients: (pair: R2CredentialPair) => typeof clients;
        }
      ).buildClients = vi.fn(() => clients);

      const contentPromise = session.getContent("p".repeat(52) + "/object");
      await vi.advanceTimersByTimeAsync(250);

      await expect(contentPromise).resolves.toEqual(
        new TextEncoder().encode("refreshed"),
      );
      expect(api.fetchR2Token).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries the API again on a later request after retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const refreshed = credentials("2099-01-01T00:00:00Z", "refreshed");
      const { session, api } = createSession(
        credentials("2000-01-01T00:00:00Z"),
        refreshed,
      );
      vi.mocked(api.fetchR2Token)
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(refreshed);
      const clients = fakeClients("reconnected");
      (
        session as unknown as {
          buildClients: (pair: R2CredentialPair) => typeof clients;
        }
      ).buildClients = vi.fn(() => clients);

      const offlineRequest = session.getContent("p".repeat(52) + "/object");
      const offlineRejection =
        expect(offlineRequest).rejects.toThrow("Failed to fetch");
      await vi.runAllTimersAsync();
      await offlineRejection;

      await expect(session.getContent("p".repeat(52) + "/object")).resolves.toEqual(
        new TextEncoder().encode("reconnected"),
      );
      expect(api.fetchR2Token).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
