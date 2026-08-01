import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { TxtBucketCleaner } from "./bucket.ts";
import { type Creds, loadCreds } from "./creds.ts";
import { CryptoEngine } from "./crypto.ts";
import { ConsoleLogger, type Logger } from "./logger.ts";
import { TxtOwner } from "./owner.ts";
import { R2Client } from "./r2.ts";
import { Reporter } from "./stats.ts";

interface CliArgs {
  inDb: string;
  credsPath: string;
  verbose: boolean;
  dryRun: boolean;
  yes: boolean;
}

function printUsage(): void {
  console.error(
    "Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]",
  );
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "clean-bucket": { type: "string" },
      creds: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (!values["clean-bucket"] || !values.creds) {
    printUsage();
    process.exit(1);
  }
  return {
    inDb: values["clean-bucket"] as string,
    credsPath: values.creds as string,
    verbose: values.verbose as boolean,
    dryRun: values["dry-run"] as boolean,
    yes: values.yes as boolean,
  };
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
  args: CliArgs,
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

async function cleanBucket(args: CliArgs, log: Logger): Promise<number> {
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

export async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const log = new ConsoleLogger(args.verbose);
  try {
    process.exitCode = await cleanBucket(args, log);
  } catch (e) {
    log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  }
}
