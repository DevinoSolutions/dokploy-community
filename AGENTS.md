# AGENTS.md

Instructions for coding agents working in this repository (a Dokploy fork: Next.js app in `apps/dokploy`, shared code in `packages/server`, pnpm monorepo). Humans: see [CONTRIBUTING.md](CONTRIBUTING.md). Do not hand in a change you have not run.

## Setup

- Node 24.4.0 (`.nvmrc`) and pnpm 10.22.0 (`packageManager`).
- `pnpm install --frozen-lockfile`
- Branch from `canary`, open PRs against `canary`. One focused change per PR.

## Gates

Run these from the repo root before every PR. CI runs the same three jobs (`.github/workflows/pull-request.yml`).

1. `pnpm server:build` builds `packages/server`. It rewrites `packages/server/package.json` to point at `dist`; run `pnpm server:script` afterwards to restore it and do not commit that change.
2. `pnpm typecheck`
3. `pnpm test` runs vitest. It watches when attached to a terminal; for a single run use `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts <test file>`.

Also run `pnpm build` if you touched build config or Next.js pages, and `pnpm check` (Biome) to format what you changed.

### Database migrations

- Generate with `pnpm --filter=dokploy run migration:generate`; files live in `apps/dokploy/drizzle`.
- Keep them LF (`.gitattributes` enforces it). Drizzle hashes the file content, so CRLF re-runs applied migrations.
- Make every statement idempotent (`IF NOT EXISTS`, or a guarded `DO $$ ... $$` block). Run `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/db/migration-idempotency.test.ts` for any migration change.

## Try your change in a real instance

For UI or API changes, click through it. `scripts/dev-instance.sh` starts a disposable Dokploy from the current checkout and removes it afterwards.

```bash
scripts/dev-instance.sh up      # Postgres container + migrations + dev server; prints the URL
scripts/dev-instance.sh status
scripts/dev-instance.sh logs
scripts/dev-instance.sh down    # stops everything and deletes all state
```

- Needs Docker, bash, curl, Node 24.4.0 and pnpm (Linux, macOS or WSL). `up` is safe to repeat; each checkout or worktree gets its own ports and container.
- Open `<url>/register` and create a throwaway admin account. The database lives in tmpfs and is gone after `down`.
- It does not run `pnpm dokploy:setup`, so there is no Docker Swarm, Traefik or `dokploy-network`. Pages, API routes, auth and migrations work; deploying applications does not. Always run `down` when you are finished.

## Pull request

Fill in the template and include:

- **What you tested and how**: the commands you ran and their result, and the steps you clicked through in the dev instance.
- **Screenshots** for any UI change, before and after if it changed existing UI. Use whatever browser automation you have against the dev instance URL; nothing is installed for this in the repo.
- `Fixes #123` or `Refs #123` for the related issue.
- For schema changes, say that the idempotency test passed.

## Rules

- No secrets, tokens or `.env` files in commits, logs or PR text.
- Conventional Commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Do not add dependencies for a small change.
- Never push to or open PRs against the upstream `Dokploy/dokploy` repository; this fork is `DevinoSolutions/dokploy-community`.
