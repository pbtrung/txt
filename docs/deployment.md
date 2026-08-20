# Deployment — Rollout Order

1. Back up `ctl` and R2. Re-run `--init-admin`, then re-run `--init-user` for every ordinary account so path bindings, signing keys, and administrator backups are current (docs/auth.md §3).
2. Run `txt --update-ctl admin_creds.json --verbose --dry-run`; resolve every reported backup or handle problem before running it without `--dry-run`.
3. Run `--update-db` for every reachable encrypted database, before deploying UI code that creates bookmarks or shares (docs/data_model.md §2.3).
4. Configure `KEYS_CACHE` and `SHARE_REGISTRY`, then apply the registry schema with `npx wrangler d1 execute SHARE_REGISTRY --remote --file worker/migrations/0001_share_registry.sql` (docs/sharing.md §1-2).
5. Generate separate values with `openssl rand -base64 32` and install them as `R2_TICKET_SECRET` and `SHARE_GRANT_KEY`; also configure the remaining docs/auth.md §1 values, especially `ADMIN_UID`.
6. Configure R2 CORS for the exact UI origin, allowing `GET`, `PUT`, conditional-write headers, range reads, and exposing `ETag`.
7. Deploy the Worker and UI together.
8. Confirm `/v1/keys`, automatic ticket renewal after a 401, exact-path read/write, ordinary/admin prefix scope, conditional database conflicts, bookmark persistence, the complete share copy/read/delete flow, and negative handle/path/signature/grant cases.
