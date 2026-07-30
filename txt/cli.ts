import { parseArgs } from "node:util";
import { MigrateCommand } from "./migrate.ts";

const USAGE =
  "usage: txt.ts --migrate --in-creds <file> --in <file> --out-creds <file> --out <file> [--no-delete] [--verbose]";

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      migrate: { type: "boolean" },
      "in-creds": { type: "string" },
      in: { type: "string" },
      "out-creds": { type: "string" },
      out: { type: "string" },
      "no-delete": { type: "boolean" },
      verbose: { type: "boolean" },
    },
  });
  if (!values.migrate) throw new Error(USAGE);
  for (const key of ["in-creds", "in", "out-creds", "out"] as const) {
    if (!values[key]) throw new Error(`--${key} is required\n${USAGE}`);
  }
  await new MigrateCommand({
    inCredsPath: values["in-creds"]!,
    inPath: values.in!,
    outCredsPath: values["out-creds"]!,
    outPath: values.out!,
    noDelete: !!values["no-delete"],
    verbose: !!values.verbose,
  }).run();
}
