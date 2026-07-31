// Shared JSON-object validation helpers for creds.ts/r2Config.ts's small,
// hand-rolled snake_case-JSON -> typed-object parsers -- both need the same
// "is this a JSON object" guard and "is this a non-empty string field"
// check, just throwing a different Error subclass per caller (creds.ts's
// own CredsError vs. a plain Error for r2Config.ts).

export function requireObject(
  json: unknown,
  message: string,
  ErrorClass: new (message: string) => Error = Error,
): Record<string, unknown> {
  if (typeof json !== "object" || json === null) {
    throw new ErrorClass(message);
  }
  return json as Record<string, unknown>;
}

export function requireString(
  data: Record<string, unknown>,
  field: string,
  ErrorClass: new (message: string) => Error = Error,
): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ErrorClass(`${field} is required`);
  }
  return value;
}
