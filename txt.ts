// Usage: node txt.ts --clean-bucket --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --init-admin <creds.json> [-v|--verbose]
//        node txt.ts --migrate --from <in.db> --from-creds <from_creds.json> --to-creds <to_creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
//        node txt.ts --update-db-catalog --creds <creds.json> [-v|--verbose] [--dry-run]
//        node txt.ts --update-db-prefixHash --creds <creds.json> [-v|--verbose] [--dry-run]
//        --update-db-catalog rewrites every owned txtMetadata.catalog row, including existing catalog blobs.
//        --update-db-prefixHash backfills missing and repairs incorrect owned txt.prefixHash values.
import { run } from "./txt/cli.ts";

run();
