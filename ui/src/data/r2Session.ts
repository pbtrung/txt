import { R2AuthorizationError, R2Client, type R2Object } from "./r2";
import { isNetworkError, withNetworkRetries } from "./networkRequest";
import type { R2CredentialPair, R2SigningIdentity, WorkerClient } from "./workerClient";

const EXPIRY_SKEW_MS = 60_000;

export class R2Session {
  private expiresAt: number;
  private clients: { dbPath: R2Client; dbPrefix: R2Client };
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly worker: WorkerClient,
    private readonly signing: R2SigningIdentity,
    private readonly dbPath: string,
    private readonly dbPrefix: string,
    initialCredentials: R2CredentialPair,
  ) {
    this.expiresAt = credentialExpiry(initialCredentials);
    this.clients = this.buildClients(initialCredentials);
  }

  getDatabase(): Promise<R2Object | null> {
    return this.withCredential("dbPath", (client) => client.getDatabase(this.dbPath));
  }

  putDatabase(bytes: Uint8Array, etag: string | null): Promise<string> {
    return this.withCredential("dbPath", (client) =>
      client.putDatabase(this.dbPath, bytes, etag),
    );
  }

  getContent(key: string): Promise<Uint8Array | null> {
    return this.withCredential("dbPrefix", (client) => client.getObject(key));
  }

  putShared(key: string, bytes: Uint8Array): Promise<void> {
    return this.withCredential("dbPrefix", (client) => client.putImmutable(key, bytes));
  }

  deleteShared(key: string): Promise<void> {
    return this.withCredential("dbPrefix", (client) => client.deleteObject(key));
  }

  createShareGrant(
    sharePrefix: string,
    sharePath: string,
    shareId: string,
  ): Promise<string> {
    return this.worker.createShareGrant({
      dbPath: this.dbPath,
      dbPrefix: this.dbPrefix,
      sharePrefix,
      sharePath,
      shareId,
    });
  }

  deleteShareRegistration(
    sharePrefix: string,
    sharePath: string,
    shareId: string,
  ): Promise<void> {
    return this.worker.deleteShare({
      dbPath: this.dbPath,
      dbPrefix: this.dbPrefix,
      sharePrefix,
      sharePath,
      shareId,
    });
  }

  private async withCredential<T>(
    type: "dbPath" | "dbPrefix",
    operation: (client: R2Client) => Promise<T>,
  ): Promise<T> {
    await this.refreshIfNeeded(false);
    try {
      return await operation(this.clients[type]);
    } catch (error) {
      // R2 authentication failures are sometimes exposed to browsers as a
      // generic fetch/CORS error, so renew once after either failure shape.
      if (!(error instanceof R2AuthorizationError) && !isNetworkError(error)) {
        throw error;
      }
      await this.refreshIfNeeded(true);
      return operation(this.clients[type]);
    }
  }

  private async refreshIfNeeded(force: boolean): Promise<void> {
    if (!force && Date.now() + EXPIRY_SKEW_MS < this.expiresAt) {
      return;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  private async refresh(): Promise<void> {
    const credentials = await withNetworkRetries((signal) =>
      this.fetchCredentials(signal),
    );
    this.expiresAt = credentialExpiry(credentials);
    this.clients = this.buildClients(credentials);
  }

  private fetchCredentials(signal: AbortSignal): Promise<R2CredentialPair> {
    return this.worker.fetchR2Token(this.dbPath, this.dbPrefix, this.signing, signal);
  }

  private buildClients(credentials: R2CredentialPair) {
    return {
      dbPath: new R2Client(credentials.dbPath),
      dbPrefix: new R2Client(credentials.dbPrefix),
    };
  }
}

function credentialExpiry(credentials: R2CredentialPair): number {
  const expiresAt = Math.min(
    Date.parse(credentials.dbPath.expiration),
    Date.parse(credentials.dbPrefix.expiration),
  );
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}
