import { parseArgs } from "node:util";
import { MigrateCommand } from "./migrate.ts";
import { CleanBucketCommand } from "./cleanBucket.ts";
import { CollectGarbageCommand } from "./collectGarbage.ts";

const USAGE = `usage:
  txt.ts --migrate --in-creds <file> --in <file> --out-creds <file> --out <file> [--no-delete] [--verbose]
  txt.ts --clean-bucket --creds <file> --db <file> [--dry-run] [--verbose]
  txt.ts --collect-garbage --db <file> [--dry-run] [--verbose]`;

const OPTIONS = {
  migrate: { type: "boolean" },
  "clean-bucket": { type: "boolean" },
  "collect-garbage": { type: "boolean" },
  "in-creds": { type: "string" },
  in: { type: "string" },
  "out-creds": { type: "string" },
  out: { type: "string" },
  creds: { type: "string" },
  db: { type: "string" },
  "no-delete": { type: "boolean" },
  "dry-run": { type: "boolean" },
  verbose: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv.slice(2), options: OPTIONS });
  if (values.migrate) return runMigrate(values);
  if (values["clean-bucket"]) return runCleanBucket(values);
  if (values["collect-garbage"]) return runCollectGarbage(values);
  throw new Error(USAGE);
}

function requiredArg(values: Values, key: keyof Values): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required\n${USAGE}`);
  return value as string;
}

async function runMigrate(values: Values): Promise<void> {
  await new MigrateCommand({
    inCredsPath: requiredArg(values, "in-creds"),
    inPath: requiredArg(values, "in"),
    outCredsPath: requiredArg(values, "out-creds"),
    outPath: requiredArg(values, "out"),
    noDelete: !!values["no-delete"],
    verbose: !!values.verbose,
  }).run();
}

async function runCleanBucket(values: Values): Promise<void> {
  await new CleanBucketCommand({
    credsPath: requiredArg(values, "creds"),
    dbPath: requiredArg(values, "db"),
    dryRun: !!values["dry-run"],
    verbose: !!values.verbose,
  }).run();
}

async function runCollectGarbage(values: Values): Promise<void> {
  await new CollectGarbageCommand({
    dbPath: requiredArg(values, "db"),
    dryRun: !!values["dry-run"],
    verbose: !!values.verbose,
  }).run();
}
