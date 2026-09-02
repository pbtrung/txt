// Holds the two 15-minute scoped R2 credentials docs/storage_layout.md
// §"Credentials" mints (`documents`: read-write over documents/* and
// shared/*; `catalog`: read-only over catalog/*), refreshing both
// together with a fresh proof on expiry or an R2 authorization failure.
import { R2AuthorizationError, R2Client } from "./r2";
import { isNetworkError, withNetworkRetries } from "./networkRequest";
import type { ApiClient, R2CredentialSet } from "./apiClient";
import type { OwnerSigningIdentity } from "./ownerProof";

const EXPIRY_SKEW_MS = 60_000;

export class R2Session {
  private expiresAt: number;
  private clients: { documents: R2Client; catalog: R2Client };
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly api: ApiClient,
    private readonly signing: OwnerSigningIdentity,
    private readonly dbPrefix: string,
    initialCredentials: R2CredentialSet,
  ) {
    this.expiresAt = initialCredentials.expiresAt * 1000;
    this.clients = this.buildClients(initialCredentials);
  }

  getDocument(key: string): Promise<Uint8Array | null> {
    return this.withCredential("documents", (client) => client.getObject(key));
  }

  putShared(key: string, bytes: Uint8Array): Promise<void> {
    return this.withCredential("documents", (client) =>
      client.putImmutable(key, bytes),
    );
  }

  getCatalogObject(key: string): Promise<Uint8Array | null> {
    return this.withCredential("catalog", (client) => client.getObject(key));
  }

  private async withCredential<T>(
    type: "documents" | "catalog",
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
      this.api.fetchR2Credentials(this.signing, this.dbPrefix, signal),
    );
    this.expiresAt = credentials.expiresAt * 1000;
    this.clients = this.buildClients(credentials);
  }

  private buildClients(credentials: R2CredentialSet) {
    return {
      documents: new R2Client(
        credentials.documents,
        credentials.endpoint,
        credentials.bucket,
      ),
      catalog: new R2Client(
        credentials.catalog,
        credentials.endpoint,
        credentials.bucket,
      ),
    };
  }
}
