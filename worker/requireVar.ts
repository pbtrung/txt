// `wrangler types` infers each `vars` entry's type from its committed
// wrangler.jsonc placeholder value, as a narrow, optional string literal --
// not the general, always-present `string` these actually are once
// scripts/deploy.sh substitutes the real values. Reading through this
// (rather than a bare `as string`) also catches the genuine
// misconfiguration case: a deploy that forgot to substitute a placeholder.
export function requireVar(value: string | undefined, name: string): string {
  if (!value || value.startsWith("replace-me-")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}
