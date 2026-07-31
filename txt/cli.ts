import { parseArgs } from "node:util";
import {
  MigrateCommand,
  CleanBucketCommand,
  CollectGarbageCommand,
  VacuumCommand,
  UpdateDbCommand,
  TestPerfCommand,
  TestWriteCommand,
} from "./commands.ts";

const USAGE = `usage:
  txt.ts --migrate --in-creds <file> --in <file> --out-creds <file> --out <file> [--no-delete] [--verbose]
  txt.ts --clean-bucket --creds <file> --db <file> [--dry-run] [--verbose]
  txt.ts --collect-garbage --db <file> [--dry-run] [--verbose]
  txt.ts --vacuum --creds <file> --db <file> [--verbose]
  txt.ts --update-db --creds <file> --db <file> [--verbose]
  txt.ts --test-perf --creds <file> [--verbose]
  txt.ts --test-write --creds <file> [--log-file <file>] [--verbose]`;

const OPTIONS = {
  migrate: { type: "boolean" },
  "clean-bucket": { type: "boolean" },
  "collect-garbage": { type: "boolean" },
  vacuum: { type: "boolean" },
  "update-db": { type: "boolean" },
  "test-perf": { type: "boolean" },
  "test-write": { type: "boolean" },
  "in-creds": { type: "string" },
  in: { type: "string" },
  "out-creds": { type: "string" },
  out: { type: "string" },
  creds: { type: "string" },
  db: { type: "string" },
  "log-file": { type: "string" },
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
  if (values.vacuum) return runVacuum(values);
  if (values["update-db"]) return runUpdateDb(values);
  if (values["test-perf"]) return runTestPerf(values);
  if (values["test-write"]) return runTestWrite(values);
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

async function runVacuum(values: Values): Promise<void> {
  await new VacuumCommand({
    credsPath: requiredArg(values, "creds"),
    dbPath: requiredArg(values, "db"),
    verbose: !!values.verbose,
  }).run();
}

async function runUpdateDb(values: Values): Promise<void> {
  await new UpdateDbCommand({
    credsPath: requiredArg(values, "creds"),
    dbPath: requiredArg(values, "db"),
    verbose: !!values.verbose,
  }).run();
}

async function runTestPerf(values: Values): Promise<void> {
  await new TestPerfCommand({
    credsPath: requiredArg(values, "creds"),
    verbose: !!values.verbose,
  }).run();
}

async function runTestWrite(values: Values): Promise<void> {
  await new TestWriteCommand({
    credsPath: requiredArg(values, "creds"),
    logFilePath: values["log-file"] ?? "test-write.log",
    verbose: !!values.verbose,
  }).run();
}
