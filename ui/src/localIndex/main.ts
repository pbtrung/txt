// The actual bundle entry point ui/scripts/build-integrity.mjs inlines into
// local_index.html's <script>. __ASSET_BASE_URL__/__SLHDSA_PUBKEY_B64__ are
// replaced with literal values at that build step (Vite's `define`) -- never
// fetched or read from anywhere else at runtime. See boot.ts for the actual
// logic; this file is intentionally too thin to need its own test.

import { boot } from "./boot";

declare const __ASSET_BASE_URL__: string;
declare const __SLHDSA_PUBKEY_B64__: string;

void boot(__ASSET_BASE_URL__, __SLHDSA_PUBKEY_B64__);
