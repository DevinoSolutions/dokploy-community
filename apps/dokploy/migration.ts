import { migration } from "./server/db/migration";
import { flushSentry } from "./server/sentry";

// Entrypoint for `dist/migration.mjs` (Dockerfile CMD and `pnpm start`). The
// shared `migration()` runs drizzle's migrator, then the fork schema catch-up
// pass, and reports a failing batch to Sentry instead of only logging it. It
// never throws: the server still boots so an install is never bricked.
await migration();
await flushSentry();
// Exit explicitly so a lingering transport socket cannot delay the server
// start that follows in the container command.
process.exit(0);
