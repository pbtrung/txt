// Calls this project's own Cloudflare Worker (docs/auth.md §4) to exchange
// a Firebase ID token for wrapped key material, or a short-lived R2
// temporary credential. Requests are always relative (/v1/...): wrangler.jsonc's
// assets block serves this build from the same origin the Worker itself
// answers /v1/* on (CLAUDE.md), so there's no separate Worker URL to
// configure or carry around.
import { objectRecord, stringField } from "../util/validation";

type AccountType = "admin" | "user";

export interface KeysResponse {
  type: AccountType;
  umk: string; // base64
  credStore: string; // base64
}

export interface R2TempCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string; // ISO 8601
  endpoint: string;
  bucket: string;
  region: string;
}

export class WorkerClient {
  constructor(private readonly idToken: string) {}

  async fetchKeys(): Promise<KeysResponse> {
    const resp = await this.post("/v1/keys");
    if (resp.status === 403) {
      throw new Error(
        "account not provisioned yet -- ask the administrator to set it up",
      );
    }
    if (!resp.ok) throw new Error(`could not obtain key material: ${resp.status}`);
    return parseKeysResponse(await resp.json());
  }

  async fetchR2Token(dbPath: string, dbPrefix: string): Promise<R2TempCredential> {
    const resp = await this.post("/v1/r2-token", {
      db_path: dbPath,
      db_prefix: dbPrefix,
    });
    if (!resp.ok) throw new Error(`could not obtain an R2 credential: ${resp.status}`);
    return parseR2Credential(await resp.json());
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.idToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
}

function parseKeysResponse(value: unknown): KeysResponse {
  const data = objectRecord(value, "key response");
  const type = data.type;
  if (type !== "admin" && type !== "user") {
    throw new Error("key response has an invalid account type");
  }
  return {
    type,
    umk: stringField(data, "umk", "key response"),
    credStore: stringField(data, "cred_store", "key response"),
  };
}

function parseR2Credential(value: unknown): R2TempCredential {
  const data = objectRecord(value, "R2 credential response");
  return {
    accessKeyId: stringField(data, "access_key_id", "R2 credential response"),
    secretAccessKey: stringField(data, "secret_access_key", "R2 credential response"),
    sessionToken: stringField(data, "session_token", "R2 credential response"),
    expiration: stringField(data, "expiration", "R2 credential response"),
    endpoint: stringField(data, "endpoint", "R2 credential response"),
    bucket: stringField(data, "bucket", "R2 credential response"),
    region: stringField(data, "region", "R2 credential response"),
  };
}
