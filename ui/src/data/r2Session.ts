import { R2AuthorizationError, R2Client, type R2Object } from "./r2";
import type { R2CredentialPair, R2SigningIdentity, WorkerClient } from "./workerClient";

const EXPIRY_SKEW_MS = 60_000;
const REFRESH_RETRY_DELAY_MS = 250;

export class R2Session {
  private credentials: R2CredentialPair;
  private clients: { dbPath: R2Client; dbPrefix: R2Client };
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly worker: WorkerClient,
    private readonly signing: R2SigningIdentity,
    private readonly dbPath: string,
    private readonly dbPrefix: string,
    initialCredentials: R2CredentialPair,
  ) {
    this.credentials = initialCredentials;
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

  private async withCredential<T>(
    type: "dbPath" | "dbPrefix",
    operation: (client: R2Client) => Promise<T>,
  ): Promise<T> {
    await this.refreshIfNeeded(false);
    try {
      return await operation(this.clients[type]);
    } catch (error) {
      if (!(error instanceof R2AuthorizationError)) throw error;
      await this.refreshIfNeeded(true);
      return operation(this.clients[type]);
    }
  }

  private async refreshIfNeeded(force: boolean): Promise<void> {
    const expiresAt = Math.min(
      Date.parse(this.credentials.dbPath.expiration),
      Date.parse(this.credentials.dbPrefix.expiration),
    );
    if (
      !force &&
      Number.isFinite(expiresAt) &&
      Date.now() + EXPIRY_SKEW_MS < expiresAt
    ) {
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
    let credentials: R2CredentialPair;
    try {
      credentials = await this.fetchCredentials();
    } catch (error) {
      if (!isFetchNetworkError(error)) throw error;
      await delay(REFRESH_RETRY_DELAY_MS);
      credentials = await this.fetchCredentials();
    }
    this.credentials = credentials;
    this.clients = this.buildClients(credentials);
  }

  private fetchCredentials(): Promise<R2CredentialPair> {
    return this.worker.fetchR2Token(this.dbPath, this.dbPrefix, this.signing);
  }

  private buildClients(credentials: R2CredentialPair) {
    return {
      dbPath: new R2Client(credentials.dbPath),
      dbPrefix: new R2Client(credentials.dbPrefix),
    };
  }
}

function isFetchNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
