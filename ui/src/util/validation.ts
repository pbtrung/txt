export function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing ${key}`);
  }
  return value;
}

export function stringArrayField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = record[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} has an invalid ${key}`);
  }
  return value as string[];
}
