// Calls this project's own Cloudflare Worker (docs/auth.md §4) to exchange
// a Firebase ID token for wrapped key material, or a short-lived R2
// temporary credential.
export type AccountType = "admin" | "user";

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
  constructor(
    private readonly baseUrl: string,
    private readonly idToken: string,
  ) {}

  async fetchKeys(): Promise<KeysResponse> {
    const resp = await this.post("/v1/keys");
    if (resp.status === 403) {
      throw new Error(
        "account not provisioned yet -- ask the administrator to set it up",
      );
    }
    if (!resp.ok) throw new Error(`could not obtain key material: ${resp.status}`);
    const data = (await resp.json()) as {
      type: AccountType;
      umk: string;
      cred_store: string;
    };
    return { type: data.type, umk: data.umk, credStore: data.cred_store };
  }

  async fetchR2Token(dbPath: string, dbPrefix: string): Promise<R2TempCredential> {
    const resp = await this.post("/v1/r2-token", {
      db_path: dbPath,
      db_prefix: dbPrefix,
    });
    if (!resp.ok) throw new Error(`could not obtain an R2 credential: ${resp.status}`);
    const data = (await resp.json()) as {
      access_key_id: string;
      secret_access_key: string;
      session_token: string;
      expiration: string;
      endpoint: string;
      bucket: string;
      region: string;
    };
    return {
      accessKeyId: data.access_key_id,
      secretAccessKey: data.secret_access_key,
      sessionToken: data.session_token,
      expiration: data.expiration,
      endpoint: data.endpoint,
      bucket: data.bucket,
      region: data.region,
    };
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.idToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
}
