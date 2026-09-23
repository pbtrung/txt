// Classifies a D1 exception by the SQLite constraint it names, so an
// endpoint can translate only the failures its own request caused into a
// 4xx and let everything else (a transient or internal D1 failure) reach
// the Worker's server-error path. D1 surfaces SQLite's own message text,
// e.g. "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT".
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export function isForeignKeyViolation(error: unknown): boolean {
  return errorMessage(error).includes("FOREIGN KEY constraint failed");
}

/** True for a UNIQUE/PRIMARY KEY violation, optionally only on `column`. */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  const message = errorMessage(error);
  const match = /UNIQUE constraint failed: ([^:]+)/.exec(message);
  return match !== null && (column === undefined || match[1].includes(column));
}
