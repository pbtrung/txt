// Low-level S3-compatible R2 operations using one short-lived credential.
// The session refreshes credentials; bounded transfer retries live here.
import { AwsClient } from "aws4fetch";

import { withNetworkRetries } from "./networkRequest";
import type { R2TempCredential } from "./apiClient";

export class R2AuthorizationError extends Error {}
export class R2ConflictError extends Error {}

export class R2Client {
  private readonly aws: AwsClient;
  private readonly base: string;

  constructor(credential: R2TempCredential, endpoint: string, bucket: string) {
    this.aws = new AwsClient({
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      sessionToken: credential.sessionToken,
      region: "auto",
      service: "s3",
    });
    this.base = `${endpoint.replace(/\/$/, "")}/${bucket}`;
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    return withNetworkRetries(async (signal) => {
      const response = await this.aws.fetch(`${this.base}/${key}`, { signal });
      if (response.status === 404) return null;
      this.requireSuccess(response, `R2 GET ${key}`);
      return new Uint8Array(await response.arrayBuffer());
    });
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const response = await withNetworkRetries((signal) =>
      this.aws.fetch(`${this.base}/${key}`, {
        method: "PUT",
        headers: {
          "If-None-Match": "*",
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-store",
        },
        body: new Uint8Array(bytes),
        signal,
      }),
    );
    if (response.status === 412) throw new R2ConflictError(`R2 PUT ${key} exists`);
    this.requireSuccess(response, `R2 PUT ${key}`);
  }

  private requireSuccess(response: Response, operation: string): void {
    if (response.status === 401 || response.status === 403) {
      throw new R2AuthorizationError(`${operation} authorization failed`);
    }
    if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
  }
}
