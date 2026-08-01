// --clean-bucket: deletes every R2 object not referenced by one account's
// txt_parts.path/txt_metadata.content. See txt/ for the implementation
// (docs/data_model.md as of commit 1ed39d433365c39a6973303c171c7bb5510d7e3e
// documents the schema this assumes -- not this branch's InstantDB design
// docs, which are unrelated).
//
// Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
import { run } from "./txt/cli.ts";

run();
