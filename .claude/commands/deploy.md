---
description: Run release checks, then deploy the Worker/UI to Cloudflare via scripts/deploy.sh
---

# Deploy

`npm run deploy` runs `scripts/deploy.sh`, which resolves or creates the
production D1 database and R2 bucket, applies pending D1 migrations,
builds the UI, and deploys the Worker (`docs/deployment.md` §1/§5). This
touches real production infrastructure — treat every step here as
higher-stakes than `/commit`, and there is no separate staging environment
in this design to rehearse against first.

## Steps

1. Run `/check` (or its equivalent battery: pytest, ruff, ui/worker
   typecheck+test, lint, format:check, ui:build) first. Do not deploy on
   top of a failing check — stop and report the failure instead.
2. Run `git status`. If there are uncommitted changes, ask whether to
   commit first (`/commit`) or deploy the working tree as-is; don't
   assume either way.
3. Resolve the config file: an explicit argument to this command if
   given, else `creds/deploy.json` (`scripts/deploy.sh`'s own default).
   Read it and show the user a summary of the non-secret values it will
   deploy with — `BUCKET_NAME`, `OWNER_EMAIL`, `CF_ACCOUNT_ID`,
   `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and whether
   `SKIP_ACCESS_CHECK` is set (`docs/deployment.md` §2).
4. If `SKIP_ACCESS_CHECK` is `true`, call this out explicitly before
   proceeding: it deploys `/v1/*` with no Access session required at all.
   Confirm that's actually intended (e.g. bootstrapping before an Access
   application exists yet), not left on by accident.
5. Show the step 3 summary and ask for explicit confirmation before
   deploying, unless the user's own request already made the target and
   intent unambiguous.
6. Run `npm run deploy` (or `sh scripts/deploy.sh <config path>` for a
   non-default path). Surface its output as it runs — it reports D1/R2
   resolution, migration application, the build, and the deploy itself,
   and prints its own closing reminders about secrets, the Access
   application, and R2 CORS.
7. After a successful deploy, walk through `docs/deployment.md` §7's
   release-verification checklist with the user. Report which items this
   session can actually exercise (e.g. hitting the deployed `/v1/*`
   routes and checking status codes) versus which need the user's own
   manual action (the Access application and WAF rule live only in the
   dashboard, `wrangler` has no command for either; R2 CORS likewise; a
   real end-to-end browser walkthrough). Never report an item as verified
   without having actually exercised it.

## Rules

- Never invent or fill in `creds/deploy.json` values yourself — if it's
  missing or incomplete, tell the user what `scripts/deploy.sh` needs
  (`docs/deployment.md` §2) and stop; do not create a placeholder file.
- Never print, log, or commit the contents of any `wrangler secret`
  (`SHARE_GRANT_KEY`, `TICKET_SIGNING_KEY`, `R2_PARENT_ACCESS_KEY_ID`,
  `R2_PARENT_SECRET_ACCESS_KEY`) or of `creds/deploy.json` itself.
- Never leave `SKIP_ACCESS_CHECK: true` unmentioned to the user — it means
  `/v1/*` has no authentication at all.
- Do not attempt the dashboard-only steps (Access application, WAF rule,
  R2 CORS) yourself — this session has no access to the Cloudflare
  dashboard; tell the user what to do there instead.
