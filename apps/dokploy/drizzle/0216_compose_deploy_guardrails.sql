-- Opt-in Compose deploy guardrails (phase timestamps, docker events, health check).
-- Nullable jsonb, no default: NULL = every guardrail off. Guarded so a re-run is a no-op.
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "deployGuardrails" jsonb;
