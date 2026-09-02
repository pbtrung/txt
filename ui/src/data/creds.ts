// docs/auth.md §3/§5: the browser's own unlock file carries exactly the
// one secret nothing else can derive, `user_root_key`. Everything else
// the owner session needs comes from GET /v1/owner once Access has
// authenticated the browser at the edge.
import { fromBase64, toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";

const USER_ROOT_KEY_BYTES = 256;

export interface BrowserCreds {
  user_root_key: string;
}

export function parseBrowserCreds(data: unknown): BrowserCreds {
  const record = objectRecord(data, "unlock file");
  const userRootKey = stringField(record, "user_root_key", "unlock file");
  const bytes = fromBase64(userRootKey);
  if (bytes.byteLength !== USER_ROOT_KEY_BYTES || toBase64(bytes) !== userRootKey) {
    throw new Error(
      `unlock file user_root_key must be ${USER_ROOT_KEY_BYTES} bytes in base64`,
    );
  }
  return { user_root_key: userRootKey };
}
