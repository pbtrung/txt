import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { AdminInitializer } from "./adminInit.ts";
import { TxtBucketCleaner } from "./bucket.ts";
import { GarbageCollector } from "./collectGarbage.ts";
import { type Creds, loadCreds } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import { loadGcCreds } from "./gcCreds.ts";
import {
  ensureUserRootKeyGenerated,
  loadInitAdminCreds,
} from "./initAdminCreds.ts";
import { ConsoleLogger, type Logger } from "./logger.ts";
import { Migrator } from "./migrate.ts";
import { TxtOwner } from "./owner.ts";
import { R2Client } from "./r2.ts";
import { Reporter } from "./stats.ts";

type CliArgs =
  | {
      command: "clean-bucket";
      inDb: string;
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
      yes: boolean;
    }
  | { command: "init-admin"; credsPath: string; verbose: boolean }
  | {
      command: "migrate";
      fromDb: string;
      fromCredsPath: string;
      toCredsPath: string;
      verbose: boolean;
      dryRun: boolean;
      yes: boolean;
    }
  | {
      command: "collect-garbage";
      credsPath: string;
      verbose: boolean;
      dryRun: boolean;
      yes: boolean;
    };

function printUsage(): void {
  console.error(
    "Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]\n" +
      "       node txt.ts --init-admin <creds.json> [-v|--verbose]\n" +
      "       node txt.ts --migrate --from <in.db> --from-creds <from_creds.json> --to-creds <to_creds.json> [-v|--verbose] [--dry-run] [-y|--yes]\n" +
      "       node txt.ts --collect-garbage --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]",
  );
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "clean-bucket": { type: "string" },
      "init-admin": { type: "string" },
      migrate: { type: "boolean", default: false },
      "collect-garbage": { type: "boolean", default: false },
      from: { type: "string" },
      "from-creds": { type: "string" },
      "to-creds": { type: "string" },
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
  if (
    values.migrate &&
    values.from &&
    values["from-creds"] &&
    values["to-creds"]
  ) {
    return {
      command: "migrate",
      fromDb: values.from,
      fromCredsPath: values["from-creds"],
      toCredsPath: values["to-creds"],
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
      yes: values.yes!,
    };
  }
  if (values["clean-bucket"] && values.creds) {
    return {
      command: "clean-bucket",
      inDb: values["clean-bucket"],
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
      yes: values.yes!,
    };
  }
  if (values["collect-garbage"] && values.creds) {
    return {
      command: "collect-garbage",
      credsPath: values.creds,
      verbose: values.verbose!,
      dryRun: values["dry-run"]!,
      yes: values.yes!,
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

async function reportAndExit(
  cleaner: TxtBucketCleaner,
  creds: Creds,
  args: Extract<CliArgs, { command: "clean-bucket" }>,
  log: Logger,
): Promise<number> {
  const { stats, orphans } = await cleaner.clean(creds, {
    dryRun: args.dryRun,
    confirm: (message) => confirm(message, args.yes),
  });
  const reporter = new Reporter(log);
  reporter.printOrphanPreview(orphans);
  reporter.printStats(stats);
  return stats.deleteErrors.length > 0 ? 1 : 0;
}

async function cleanBucket(
  args: Extract<CliArgs, { command: "clean-bucket" }>,
  log: Logger,
): Promise<number> {
  const creds = loadCreds(args.credsPath, args.dryRun);
  const cryptoEngine = await CryptoEngine.create();
  const db = new DatabaseSync(args.inDb, { readOnly: true });
  try {
    const owner = new TxtOwner(db, cryptoEngine, log);
    const r2 = new R2Client(creds.r2Config, args.dryRun, log);
    const cleaner = new TxtBucketCleaner(owner, r2, log);
    return await reportAndExit(cleaner, creds, args, log);
  } finally {
    db.close();
  }
}

async function initAdmin(
  args: Extract<CliArgs, { command: "init-admin" }>,
  log: Logger,
): Promise<number> {
  ensureUserRootKeyGenerated(args.credsPath, log);
  const creds = loadInitAdminCreds(args.credsPath);
  const result = await new AdminInitializer(creds, log).run();
  log.info("--- init-admin summary ---");
  log.info(`auth.id:     ${result.authId}`);
  log.info(`dbMeta:      ${result.dbMetaId}`);
  log.info(`page count:  ${result.pageCount}`);
  log.info(`version:     ${result.version}`);
  return 0;
}

async function migrate(
  args: Extract<CliArgs, { command: "migrate" }>,
  log: Logger,
): Promise<number> {
  // The "from" side is always read-only for --migrate (it only ever
  // downloads from the legacy bucket, never writes) -- loadCreds(path, true)
  // skips the read-write-key requirement regardless of --migrate's own
  // --dry-run flag.
  const fromCreds = loadCreds(args.fromCredsPath, true);
  // --migrate reads the target's R2 config from its own live credStore row
  // (migrate.ts's unwrapTargetKeys), not from to-creds.json -- no local
  // r2_config required here.
  const toCreds = loadInitAdminCreds(args.toCredsPath, { requireR2: false });
  const fromDb = new DatabaseSync(args.fromDb, { readOnly: true });
  try {
    const migrator = new Migrator(fromDb, fromCreds, toCreds, log);
    const result = await migrator.run({
      dryRun: args.dryRun,
      confirm: (message) => confirm(message, args.yes),
    });
    printMigrateSummary(result, log);
    return 0;
  } finally {
    fromDb.close();
  }
}

function printMigrateSummary(
  result: Awaited<ReturnType<Migrator["run"]>>,
  log: Logger,
): void {
  log.info("--- migrate summary ---");
  log.info(`mode:              ${result.committed ? "live" : "dry-run"}`);
  log.info(`documents:         ${result.migrated.length}`);
  log.info(`already migrated:  ${result.alreadyMigratedCount}`);
  log.info(`stale R2 objects:  ${result.staleObjectsDeleted} deleted`);
  for (const d of result.migrated) {
    log.info(
      `  txt_id=${d.oldTxtId} name=${JSON.stringify(d.name)} parts=${d.partCount}`,
    );
  }
  if (result.committed) {
    log.info(`auth.id:           ${result.authId}`);
    log.info(`new version:       ${result.newVersion}`);
    log.info(`page count:        ${result.pageCount}`);
  }
}

async function collectGarbage(
  args: Extract<CliArgs, { command: "collect-garbage" }>,
  log: Logger,
): Promise<number> {
  const creds = loadGcCreds(args.credsPath);
  const collector = new GarbageCollector(creds, log);
  const result = await collector.run({
    dryRun: args.dryRun,
    confirm: (message) => confirm(message, args.yes),
  });
  printCollectGarbageSummary(result, log);
  return 0;
}

function printCollectGarbageSummary(
  result: Awaited<ReturnType<GarbageCollector["run"]>>,
  log: Logger,
): void {
  log.info("--- collect-garbage summary ---");
  log.info(`mode:              ${result.dryRun ? "dry-run" : "live"}`);
  log.info(`accounts:          ${result.accounts.length}`);
  for (const a of result.accounts) {
    if (a.skipped) {
      log.info(`  auth.id=${a.authId} SKIPPED (${a.skipped})`);
      continue;
    }
    log.info(
      `  auth.id=${a.authId} old-pages=${a.oldPagesDeleted} stale-objects=${a.staleObjectsDeleted}`,
    );
  }
}

async function dispatch(args: CliArgs, log: Logger): Promise<number> {
  if (args.command === "init-admin") return initAdmin(args, log);
  if (args.command === "migrate") return migrate(args, log);
  if (args.command === "collect-garbage") return collectGarbage(args, log);
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
