import { toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";

const OWNER_SQL = `
SELECT firebase_uid, wrapped_umk, sign_version, sign_algorithm,
       wrapped_sign_private_key, encrypted_credentials
FROM owner_control
WHERE singleton = 1
`;

export interface RqliteOwnerKeys {
  uid: string;
  wrappedUmk: Uint8Array;
  signing: {
    version: number;
    algorithm: "ECDSA-P521-SHA512";
    wrappedPrivateKey: Uint8Array;
  };
  encryptedCredentials: Uint8Array;
}

export class RqliteClient {
  private readonly authorization: string;

  constructor(
    private readonly baseUrl: string,
    username: string,
    password: string,
  ) {
    this.authorization = `Basic ${toBase64(new TextEncoder().encode(`${username}:${password}`))}`;
  }

  async fetchOwnerKeys(signal?: AbortSignal): Promise<RqliteOwnerKeys> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/db/query?level=strong&blob_array`,
      {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([[OWNER_SQL, {}]]),
        signal,
      },
    );
    if (!response.ok) throw new Error(`rqlite owner lookup failed: ${response.status}`);
    return parseOwnerResponse(await response.json());
  }
}

function parseOwnerResponse(value: unknown): RqliteOwnerKeys {
  const response = objectRecord(value, "rqlite response");
  if (!Array.isArray(response.results) || response.results.length !== 1) {
    throw new Error("rqlite response must contain one result");
  }
  const result = objectRecord(response.results[0], "rqlite owner result");
  if (typeof result.error === "string") throw new Error(result.error);
  const row = firstRow(result);
  return {
    uid: stringField(row, "firebase_uid", "rqlite owner row"),
    wrappedUmk: blobField(row, "wrapped_umk"),
    signing: signingFields(row),
    encryptedCredentials: blobField(row, "encrypted_credentials"),
  };
}

function firstRow(result: Record<string, unknown>): Record<string, unknown> {
  const columns = result.columns;
  const values = result.values;
  if (!Array.isArray(columns) || !Array.isArray(values)) {
    throw new Error("rqlite owner result is malformed");
  }
  if (values.length !== 1 || !Array.isArray(values[0])) {
    throw new Error("rqlite owner is not provisioned");
  }
  if (columns.length !== values[0].length) {
    throw new Error("rqlite owner row has mismatched columns");
  }
  return Object.fromEntries(columns.map((column, index) => [column, values[0][index]]));
}

function signingFields(row: Record<string, unknown>): RqliteOwnerKeys["signing"] {
  if (row.sign_version !== 1 || row.sign_algorithm !== "ECDSA-P521-SHA512") {
    throw new Error("rqlite owner has an unsupported signing suite");
  }
  return {
    version: 1,
    algorithm: "ECDSA-P521-SHA512",
    wrappedPrivateKey: blobField(row, "wrapped_sign_private_key"),
  };
}

function blobField(row: Record<string, unknown>, name: string): Uint8Array {
  const value = row[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`rqlite owner row has an invalid ${name}`);
  }
  return new Uint8Array(value);
}
