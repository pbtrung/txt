// An R2 (S3-compatible) client for the browser, using a short-lived
// credential minted by this project's own Worker (worker/r2Token.ts) --
// read-only, scoped to this account's own db_prefix, or bucket-wide
// read-write for the admin. SigV4 request signing is delegated to
// aws4fetch rather than hand-rolled: it's a small, purpose-built library
// for signing fetch() calls to S3-compatible services from browsers/
// Workers, the same class of problem txt/r2_client.py's boto3 client
// solves server-side.
//
// The credential is a snapshot taken at construction time (900s TTL,
// worker/r2Token.ts) -- this client doesn't refresh it itself. A session
// that outlives the TTL would need a fresh R2Client; nothing here needs
// that yet.
//
// Path-style addressing ({endpoint}/{bucket}/{key}), not virtual-hosted --
// R2 supports both, and path-style needs no bucket-specific DNS/TLS setup.
import { AwsClient } from "aws4fetch";
import type { R2Config } from "./creds";
import type { R2TempCredential } from "./workerClient";

export interface R2 {
  getObject(key: string): Promise<Uint8Array>;
}

export class R2Client implements R2 {
  private readonly aws: AwsClient;
  private readonly base: string;

  constructor(config: R2Config, credential: R2TempCredential) {
    this.aws = new AwsClient({
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      sessionToken: credential.sessionToken,
      region: config.region,
      service: "s3",
    });
    this.base = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}`;
  }

  async getObject(key: string): Promise<Uint8Array> {
    const resp = await this.aws.fetch(`${this.base}/${key}`);
    if (!resp.ok) throw new Error(`R2 GET ${key} failed: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
}
