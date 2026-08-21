import { objectRecord, stringFields } from "../util/validation";

export interface BrowserCreds {
  rqlite_admin_username: string;
  rqlite_admin_password: string;
  rqlite_db_url: string;
  firebase_email: string;
  firebase_password: string;
  firebase_api_key: string;
  user_root_key: string;
}

const REQUIRED_FIELDS = [
  "rqlite_admin_username",
  "rqlite_admin_password",
  "rqlite_db_url",
  "firebase_email",
  "firebase_password",
  "firebase_api_key",
  "user_root_key",
] as const;

export function parseBrowserCreds(data: unknown): BrowserCreds {
  const record = objectRecord(data, "creds.json");
  const creds = stringFields(record, REQUIRED_FIELDS, "creds.json");
  validateRqliteUrl(creds.rqlite_db_url);
  return creds satisfies BrowserCreds;
}

export function apiOrigin(creds: BrowserCreds): string {
  return new URL(creds.rqlite_db_url).origin;
}

function validateRqliteUrl(value: string): void {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("creds.json rqlite_db_url must use HTTPS");
  }
  if (url.pathname.replace(/\/+$/, "") !== "/operator/rqlite") {
    throw new Error("creds.json rqlite_db_url must end with /operator/rqlite");
  }
  if (url.search || url.hash) {
    throw new Error("creds.json rqlite_db_url must not contain a query or fragment");
  }
  if (url.username || url.password) {
    throw new Error("creds.json rqlite_db_url must not contain embedded credentials");
  }
}
