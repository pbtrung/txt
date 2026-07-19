import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MASTER_KEY_BYTES } from "./constants.ts";

export interface CredsFile {
  master_key: string;
  [key: string]: unknown;
}

export class Creds {
  static load(path: string): CredsFile {
    if (!existsSync(path)) return { master_key: "" };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CredsFile;
    if (typeof parsed.master_key !== "string") parsed.master_key = "";
    return parsed;
  }

  static save(path: string, creds: CredsFile): void {
    const json = JSON.stringify(creds, null, 2) + "\n";
    writeFileSync(path, json, { mode: 0o600 });
  }

  static generateMasterKey(): string {
    return randomBytes(MASTER_KEY_BYTES).toString("base64");
  }
}
