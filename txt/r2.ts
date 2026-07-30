import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { R2Config } from "./creds.ts";

export class R2Client {
  private readonly readClient: S3Client;
  private readonly writeClient: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    const base = { endpoint: config.endpoint, region: config.region, forcePathStyle: true };
    this.readClient = new S3Client({
      ...base,
      credentials: {
        accessKeyId: config.read_only_access_key_id,
        secretAccessKey: config.read_only_secret_access_key,
      },
    });
    this.writeClient = new S3Client({
      ...base,
      credentials: {
        accessKeyId: config.read_write_access_key_id,
        secretAccessKey: config.read_write_secret_access_key,
      },
    });
    this.bucket = config.bucket;
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.readClient.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.writeClient.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.writeClient.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Every object key in the bucket, recursively (paginated). Read-only. */
  async list(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.readClient.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
