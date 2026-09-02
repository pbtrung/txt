// docs/storage_layout.md §1: "Every application path segment is
// validated before use in a request URL" -- share_path is the one
// caller-supplied path segment the Worker builds a real R2 key from
// (worker/sharesEndpoint.ts, worker/sharedUrlEndpoint.ts).
const BASE32_CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SHARE_PATH_PATTERN = new RegExp(`^[${BASE32_CROCKFORD_ALPHABET}]{52}$`);

export const SHARE_ID_LEN = 32;

export function isValidSharePath(sharePath: string): boolean {
  return SHARE_PATH_PATTERN.test(sharePath);
}
