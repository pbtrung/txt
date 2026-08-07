// Shared shape for "one document's own R2 prefix plus the raw_keys already
// known to live under it" (docs/data_model.md's txt entity, docs/
// protocols.md's Read path) -- bucket.ts's resolveOwnedDocuments builds one
// of these per admin-owned document to compute the whole-account known-path
// set its own orphan sweep (--clean-bucket) diffs the bucket listing
// against.
export interface OrphanSweepTarget {
  label: string; // for logging -- e.g. a target `txt` row's own id
  prefix: string; // decrypted, not the wrapped blob
  knownRawKeys: Set<string>; // bare raw_key strings, not full R2 object keys
}
