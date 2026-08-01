// Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --init-admin <creds.json> [-v|--verbose]
import { run } from "./txt/cli.ts";

run();
