import { dirname, join, resolve } from "node:path";
import { Creds } from "./txt/creds.ts";
import { SqlCipherDb, hexKeyLiteral } from "./txt/db.ts";
import { Ingest } from "./txt/ingest.ts";
import { SCHEMA_SQL } from "./txt/schema.ts";
import { DB_FILE_NAME } from "./txt/constants.ts";

interface Args {
  init: boolean;
  add: boolean;
  credsPath: string | null;
  srcDir: string | null;
}

function parseArgs(argv: string[]): Args {
  let init = false;
  let add = false;
  let credsPath: string | null = null;
  let srcDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--init") init = true;
    else if (argv[i] === "--add") add = true;
    else if (argv[i] === "--creds") credsPath = argv[++i] ?? null;
    else if (argv[i] === "--src") srcDir = argv[++i] ?? null;
  }
  return { init, add, credsPath, srcDir };
}

function refuseExistingKey(credsPath: string): void {
  console.error(
    `${credsPath} already has a master_key; refusing to overwrite. ` +
      "Remove it manually if you really want to re-initialize."
  );
  process.exitCode = 1;
}

function dbPathFor(credsPath: string): string {
  return join(dirname(resolve(credsPath)), DB_FILE_NAME);
}

async function createSchema(hostPath: string, hexKey: string): Promise<void> {
  const db = await SqlCipherDb.open(hostPath, hexKey);
  db.exec(SCHEMA_SQL);
  db.save();
  db.close();
}

async function runInit(credsPath: string): Promise<void> {
  const creds = Creds.load(credsPath);
  if (creds.master_key) {
    refuseExistingKey(credsPath);
    return;
  }
  creds.master_key = Creds.generateMasterKey();
  Creds.save(credsPath, creds);
  const dbPath = dbPathFor(credsPath);
  await createSchema(dbPath, hexKeyLiteral(creds.master_key));
  console.log(`Initialized ${dbPath}`);
}

async function runAdd(credsPath: string, srcDir: string): Promise<void> {
  const creds = Creds.load(credsPath);
  if (!creds.master_key) {
    console.error(`${credsPath} has no master_key; run --init first.`);
    process.exitCode = 1;
    return;
  }
  const db = await SqlCipherDb.open(dbPathFor(credsPath), hexKeyLiteral(creds.master_key));
  const result = Ingest.run(db, srcDir);
  db.save();
  db.close();
  console.log(`Added ${result.files} file(s), ${result.parts} part(s).`);
}

async function main(): Promise<void> {
  const { init, add, credsPath, srcDir } = parseArgs(process.argv.slice(2));
  if (init && credsPath) {
    await runInit(credsPath);
  } else if (add && credsPath && srcDir) {
    await runAdd(credsPath, srcDir);
  } else {
    console.error(
      "Usage: node txt.ts --init --creds <path>\n" +
        "       node txt.ts --add --src <dir> --creds <path>"
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
