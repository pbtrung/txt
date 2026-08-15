// An R2 (S3-compatible) client for the browser, using a short-lived
// credential minted by this project's own Worker (worker/r2Token.ts) --
// scoped read-only to this account's own db_path/db_prefix, or bucket-wide
// read-write for the admin. SigV4 request signing is delegated to
// aws4fetch: a small, purpose-built library for signing fetch() calls to
// S3-compatible services from browsers/Workers, the same class of problem
// txt/r2_client.py's boto3 client solves server-side.
//
// The credential is a snapshot taken at construction time (worker/r2Token.ts's
// TTL) -- this client doesn't refresh it itself. Path-style addressing
// ({endpoint}/{bucket}/{key}), not virtual-hosted -- R2 supports both, and
// path-style needs no bucket-specific DNS/TLS setup.
import { AwsClient } from "aws4fetch";
import type { R2TempCredential } from "./workerClient";

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

  /** Returns null for a 404 (the object doesn't exist yet). */
  async getObject(key: string): Promise<Uint8Array | null> {
    const resp = await this.aws.fetch(`${this.base}/${key}`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`R2 GET ${key} failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
}
