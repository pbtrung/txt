// Low-level S3-compatible R2 operations using one short-lived credential.
// Credential refresh and operation retry live in r2Session.ts.
import { AwsClient } from "aws4fetch";

import type { R2TempCredential } from "./workerClient";

export interface R2Object {
  bytes: Uint8Array;
  etag: string;
}

export class R2AuthorizationError extends Error {}
export class R2ConflictError extends Error {}

export class R2Client {
  private readonly aws: AwsClient;
  private readonly base: string;

  constructor(credential: R2TempCredential) {
    this.aws = new AwsClient({
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      sessionToken: credential.sessionToken,
      region: credential.region,
      service: "s3",
    });
    this.base = `${credential.endpoint.replace(/\/$/, "")}/${credential.bucket}`;
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    const response = await this.aws.fetch(`${this.base}/${key}`);
    if (response.status === 404) return null;
    this.requireSuccess(response, `R2 GET ${key}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async getDatabase(key: string): Promise<R2Object | null> {
    const response = await this.aws.fetch(`${this.base}/${key}`, {
      cache: "no-store",
    });
    if (response.status === 404) return null;
    this.requireSuccess(response, `R2 GET ${key}`);
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error(`R2 GET ${key} returned no ETag`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), etag };
  }

  async putDatabase(
    key: string,
    bytes: Uint8Array,
    expectedEtag: string | null,
  ): Promise<string> {
    const response = await this.aws.fetch(`${this.base}/${key}`, {
      method: "PUT",
      headers: expectedEtag ? { "If-Match": expectedEtag } : { "If-None-Match": "*" },
      body: new Uint8Array(bytes),
    });
    if (response.status === 412) {
      throw new R2ConflictError(`R2 PUT ${key} conflicted with a newer database`);
    }
    this.requireSuccess(response, `R2 PUT ${key}`);
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error(`R2 PUT ${key} returned no ETag`);
    return etag;
  }

  private requireSuccess(response: Response, operation: string): void {
    if (response.status === 401 || response.status === 403) {
      throw new R2AuthorizationError(`${operation} authorization failed`);
    }
    if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
  }
}
