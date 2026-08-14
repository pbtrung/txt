// A read-only R2 (S3-compatible) client for the browser, using the static
// read_only_access_key_id/secret from the client's own creds.json (see
// CLAUDE.md/the plan: reserved for exactly this since --ingest was built).
// SigV4 request signing is delegated to aws4fetch rather than hand-rolled:
// it's a small, purpose-built library for signing fetch() calls to S3-
// compatible services from browsers/Workers, the same class of environment
// txt/r2_client.py's boto3 client handles server-side.
//
// Path-style addressing ({endpoint}/{bucket}/{key}), not virtual-hosted --
// R2 supports both, and path-style needs no bucket-specific DNS/TLS setup.
import { AwsClient } from "aws4fetch";
import type { R2Config } from "./creds";

export interface R2 {
  getObject(key: string): Promise<Uint8Array>;
}

export class R2Client implements R2 {
  private readonly aws: AwsClient;
  private readonly base: string;

  constructor(config: R2Config) {
    this.aws = new AwsClient({
      accessKeyId: config.read_only_access_key_id,
      secretAccessKey: config.read_only_secret_access_key,
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
