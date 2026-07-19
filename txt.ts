import { dirname, join, resolve } from "node:path";
import { Creds } from "./txt/creds.ts";
import { SqlCipherDb, hexKeyLiteral } from "./txt/db.ts";
import { SCHEMA_SQL } from "./txt/schema.ts";
import { DB_FILE_NAME, VIRTUAL_DB_PATH } from "./txt/constants.ts";

interface Args {
  init: boolean;
  credsPath: string | null;
}

function parseArgs(argv: string[]): Args {
  let init = false;
  let credsPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--init") init = true;
    else if (argv[i] === "--creds") credsPath = argv[++i] ?? null;
  }
  return { init, credsPath };
}

function refuseExistingKey(credsPath: string): void {
  console.error(
    `${credsPath} already has a master_key; refusing to overwrite. ` +
      "Remove it manually if you really want to re-initialize."
  );
  process.exitCode = 1;
}

async function createSchema(hostPath: string, hexKey: string): Promise<void> {
  const db = await SqlCipherDb.open(VIRTUAL_DB_PATH, hexKey);
  db.exec(SCHEMA_SQL);
  db.exportTo(hostPath);
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
  const dbPath = join(dirname(resolve(credsPath)), DB_FILE_NAME);
  await createSchema(dbPath, hexKeyLiteral(creds.master_key));
  console.log(`Initialized ${dbPath}`);
}

async function main(): Promise<void> {
  const { init, credsPath } = parseArgs(process.argv.slice(2));
  if (!init || !credsPath) {
    console.error("Usage: node txt.ts --init --creds <path>");
    process.exitCode = 1;
    return;
  }
  await runInit(credsPath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
