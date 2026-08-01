// R2 (S3-compatible) object storage client. Port of txt/r2.py's R2Client:
// list/delete with the same 3-attempt/2-4-8s backoff retry pattern, plus
// batched deletion (a deliberate, documented deviation from the Python
// reference's one-key-at-a-time delete -- see docs/cli.md notes).
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import * as C from "./constants.ts";
import type { R2ConfigResolved } from "./creds.ts";
import type { Logger } from "./logger.ts";

export interface ObjectInfo {
  key: string;
  size: number;
}

export interface DeleteResult {
  deletedKeys: Set<string>;
  errors: { key: string; message: string }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialsFor(r2: R2ConfigResolved, dryRun: boolean) {
  const useReadOnly = dryRun && !r2.readWriteAccessKeyId;
  return {
    accessKeyId: useReadOnly
      ? r2.readOnlyAccessKeyId
      : r2.readWriteAccessKeyId!,
    secretAccessKey: useReadOnly
      ? r2.readOnlySecretAccessKey
      : r2.readWriteSecretAccessKey!,
  };
}

export class R2Client {
  private s3: S3Client;
  private r2: R2ConfigResolved;
  private log: Logger;

  constructor(r2: R2ConfigResolved, dryRun: boolean, log: Logger) {
    this.r2 = r2;
    this.log = log;
    this.s3 = new S3Client({
      endpoint: r2.endpoint,
      region: r2.region,
      credentials: credentialsFor(r2, dryRun),
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async listAllObjects(): Promise<ObjectInfo[]> {
    const objects: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const page = await this.fetchPage(token);
      objects.push(...page.objects);
      token = page.nextToken;
    } while (token);
    this.log.info(`Found ${objects.length} object(s) in the R2 bucket`);
    return objects;
  }

  private async fetchPage(
    token: string | undefined,
  ): Promise<{ objects: ObjectInfo[]; nextToken?: string }> {
    const resp = await this.withRetries("list bucket page", () =>
      this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.r2.bucket,
          ContinuationToken: token,
        }),
      ),
    );
    const objects = (resp.Contents ?? []).flatMap((o) =>
      o.Key ? [{ key: o.Key, size: o.Size ?? 0 }] : [],
    );
    this.log.debug(`Listed page: ${objects.length} object(s)`);
    return {
      objects,
      nextToken: resp.IsTruncated ? resp.NextContinuationToken : undefined,
    };
  }

  async deleteObjects(keys: string[]): Promise<DeleteResult> {
    const deletedKeys = new Set<string>();
    const errors: { key: string; message: string }[] = [];
    for (let i = 0; i < keys.length; i += C.S3_DELETE_BATCH_SIZE) {
      const chunk = keys.slice(i, i + C.S3_DELETE_BATCH_SIZE);
      await this.deleteBatch(chunk, deletedKeys, errors);
    }
    return { deletedKeys, errors };
  }

  private async deleteBatch(
    chunk: string[],
    deletedKeys: Set<string>,
    errors: { key: string; message: string }[],
  ): Promise<void> {
    const resp = await this.withRetries(`delete batch of ${chunk.length}`, () =>
      this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.r2.bucket,
          Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: false },
        }),
      ),
    );
    for (const d of resp.Deleted ?? []) if (d.Key) deletedKeys.add(d.Key);
    for (const e of resp.Errors ?? [])
      if (e.Key)
        errors.push({ key: e.Key, message: `${e.Code}: ${e.Message}` });
    this.log.debug(
      `Deleted batch: ${resp.Deleted?.length ?? 0} ok, ${resp.Errors?.length ?? 0} error(s)`,
    );
  }

  private async withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 1 + C.RETRY_DELAYS_MS.length;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await this.backoff(what, attempt, maxAttempts, lastErr);
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
      }
    }
    this.log.error(`${what} failed after ${maxAttempts} attempt(s), giving up`);
    throw lastErr;
  }

  private async backoff(
    what: string,
    attempt: number,
    maxAttempts: number,
    lastErr: unknown,
  ): Promise<void> {
    const delay = C.RETRY_DELAYS_MS[attempt - 1];
    this.log.warn(
      `${what} failed (attempt ${attempt}/${maxAttempts}): ${lastErr} -- retrying in ${delay / 1000}s`,
    );
    await sleep(delay);
  }
}
