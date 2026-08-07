import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AdminInitializer } from "./adminInit.ts";
import { TxtBucketCleaner } from "./bucket.ts";
import { TxtIngester } from "./ingest.ts";
import { loadScanCreds } from "./scanCreds.ts";
import {
  ensureUserRootKeyGenerated,
  loadInitAdminCreds,
} from "./initAdminCreds.ts";
import { ConsoleLogger, type Logger } from "./logger.ts";
import { Reporter } from "./stats.ts";
import { DbCatalogUpdater } from "./updateDbCatalog.ts";
import { DbPrefixHashUpdater } from "./updateDbPrefixHash.ts";

type CliArgs =
  | {
      command: "clean-bucket";
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
      yes: boolean;
    }
  | { command: "init-admin"; credsPath: string; verbose: boolean }
  | {
      command: "ingest";
      srcDir: string;
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
    }
  | {
      command: "update-db-catalog";
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
    }
  | {
      command: "update-db-prefixHash";
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
    };

function printUsage(): void {
  console.error(
    "Usage: node txt.ts --clean-bucket --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]\n" +
      "       node txt.ts --init-admin <creds.json> [-v|--verbose]\n" +
      "       node txt.ts --ingest <dir> --creds <creds.json> [-v|--verbose] [--dry-run]\n" +
      "       node txt.ts --update-db-catalog --creds <creds.json> [-v|--verbose] [--dry-run]\n" +
      "       node txt.ts --update-db-prefixHash --creds <creds.json> [-v|--verbose] [--dry-run]\n\n" +
      "Notes:\n" +
      "  --ingest cleans, splits, and uploads every .txt file in <dir> not already recorded under an owned document's name.\n" +
      "  --update-db-catalog rewrites every owned txtMetadata.catalog row, including rows that already have catalog.\n" +
      "  --update-db-prefixHash backfills missing and repairs incorrect owned txt.prefixHash values.",
  );
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "clean-bucket": { type: "boolean", default: false },
      "init-admin": { type: "string" },
      ingest: { type: "string" },
      "update-db-catalog": { type: "boolean", default: false },
      "update-db-prefixHash": { type: "boolean", default: false },
      creds: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (values["init-admin"]) {
    return {
      command: "init-admin",
      credsPath: values["init-admin"],
      verbose: values.verbose!,
    };
  }
  if (values.ingest && values.creds) {
    return {
      command: "ingest",
      srcDir: values.ingest,
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
    };
  }
  if (values["clean-bucket"] && values.creds) {
    return {
      command: "clean-bucket",
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
      yes: values.yes!,
    };
  }
  if (values["update-db-catalog"] && values.creds) {
    return {
      command: "update-db-catalog",
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
    };
  }
  if (values["update-db-prefixHash"] && values.creds) {
    return {
      command: "update-db-prefixHash",
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
    };
  }
  printUsage();
  process.exit(1);
}

async function confirm(message: string, skip: boolean): Promise<boolean> {
  if (skip) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function cleanBucket(
  args: Extract<CliArgs, { command: "clean-bucket" }>,
  log: Logger,
): Promise<number> {
  const creds = loadScanCreds(args.credsPath);
  const cleaner = new TxtBucketCleaner(creds, log);
  const { stats, orphans } = await cleaner.clean({
    dryRun: args.dryRun,
    confirm: (message) => confirm(message, args.yes),
  });
  const reporter = new Reporter(log);
  reporter.printOrphanPreview(orphans);
  reporter.printStats(stats);
  return stats.deleteErrors.length > 0 ? 1 : 0;
}

async function initAdmin(
  args: Extract<CliArgs, { command: "init-admin" }>,
  log: Logger,
): Promise<number> {
  ensureUserRootKeyGenerated(args.credsPath, log);
  const creds = loadInitAdminCreds(args.credsPath);
  const result = await new AdminInitializer(creds, log).run();
  log.info("--- init-admin summary ---");
  log.info(`auth.id:    ${result.authId}`);
  log.info(`keyStore:   ${result.keyStoreId}`);
  log.info(`credStore:  ${result.credStoreId}`);
  return 0;
}

async function ingest(
  args: Extract<CliArgs, { command: "ingest" }>,
  log: Logger,
): Promise<number> {
  const creds = loadScanCreds(args.credsPath);
  const ingester = new TxtIngester(creds, log);
  const result = await ingester.run({
    srcDir: args.srcDir,
    dryRun: args.dryRun,
  });
  printIngestSummary(result, log);
  return result.failed.length > 0 ? 1 : 0;
}

function printIngestSummary(
  result: Awaited<ReturnType<TxtIngester["run"]>>,
  log: Logger,
): void {
  log.info("--- ingest summary ---");
  log.info(`mode:      ${result.dryRun ? "dry-run" : "live"}`);
  log.info(`ingested:  ${result.ingested.length}`);
  log.info(`skipped:   ${result.skipped.length}`);
  log.info(`failed:    ${result.failed.length}`);
  for (const d of result.ingested) {
    log.info(
      `  ${JSON.stringify(d.name)}${result.dryRun ? "" : ` txt_id=${d.txtId}`} parts=${d.partCount}`,
    );
  }
  for (const f of result.failed) {
    log.info(`  FAILED ${JSON.stringify(f.name)}: ${f.error}`);
  }
}

async function updateDbCatalog(
  args: Extract<CliArgs, { command: "update-db-catalog" }>,
  log: Logger,
): Promise<number> {
  const creds = loadScanCreds(args.credsPath);
  const updater = new DbCatalogUpdater(creds, log);
  const result = await updater.run({ dryRun: args.dryRun });
  printUpdateDbCatalogSummary(result, log);
  return result.failed > 0 ? 1 : 0;
}

function printUpdateDbCatalogSummary(
  result: Awaited<ReturnType<DbCatalogUpdater["run"]>>,
  log: Logger,
): void {
  log.info("--- update-db-catalog summary ---");
  log.info(`mode:              ${result.dryRun ? "dry-run" : "live"}`);
  log.info(`documents:         ${result.documentCount}`);
  log.info(`metadata rows:     ${result.metadataRows}`);
  log.info(
    `${result.dryRun ? "prepared" : "updated"}:          ${result.updated}`,
  );
  log.info(`skipped:           ${result.skipped}`);
  log.info(`failed:            ${result.failed}`);
}

async function updateDbPrefixHash(
  args: Extract<CliArgs, { command: "update-db-prefixHash" }>,
  log: Logger,
): Promise<number> {
  const creds = loadScanCreds(args.credsPath);
  const updater = new DbPrefixHashUpdater(creds, log);
  const result = await updater.run({ dryRun: args.dryRun });
  printUpdateDbPrefixHashSummary(result, log);
  return result.failed > 0 ? 1 : 0;
}

function printUpdateDbPrefixHashSummary(
  result: Awaited<ReturnType<DbPrefixHashUpdater["run"]>>,
  log: Logger,
): void {
  log.info("--- update-db-prefixHash summary ---");
  log.info(`mode:              ${result.dryRun ? "dry-run" : "live"}`);
  log.info(`documents:         ${result.documentCount}`);
  log.info(
    `${result.dryRun ? "prepared" : "updated"}:          ${result.updated}`,
  );
  log.info(`unchanged:         ${result.unchanged}`);
  log.info(`skipped:           ${result.skipped}`);
  log.info(`failed:            ${result.failed}`);
}

async function dispatch(args: CliArgs, log: Logger): Promise<number> {
  if (args.command === "init-admin") return initAdmin(args, log);
  if (args.command === "ingest") return ingest(args, log);
  if (args.command === "update-db-catalog") return updateDbCatalog(args, log);
  if (args.command === "update-db-prefixHash")
    return updateDbPrefixHash(args, log);
  return cleanBucket(args, log);
}

export async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const log = new ConsoleLogger(args.verbose);
  try {
    process.exitCode = await dispatch(args, log);
  } catch (e) {
    log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  }
}
