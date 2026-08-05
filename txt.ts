// Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --init-admin <creds.json> [-v|--verbose]
//        node txt.ts --migrate --from <in.db> --from-creds <from_creds.json> --to-creds <to_creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --collect-garbage --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --update-db-catalog --creds <creds.json> [-v|--verbose] [--dry-run]
import { run } from "./txt/cli.ts";

run();
