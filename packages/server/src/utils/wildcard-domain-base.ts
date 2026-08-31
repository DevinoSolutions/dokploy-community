import { getDomainHostError } from "./hostname-validation";

export const WILDCARD_BASE_PREFIX_PATTERN_MESSAGE =
	'Prefix wildcards are not supported yet. Use "*.apps.example.com" (a wildcard for a whole label), not "*-apps.example.com".';

export const WILDCARD_BASE_MISPLACED_MESSAGE =
	'A wildcard base domain must be written as "*.example.com" or "example.com" — the asterisk may only appear as the leading label.';

export const WILDCARD_BASE_MULTI_LEVEL_MESSAGE =
	'Multi-level wildcards ("**.example.com") are not supported for generated domains. Use "*.example.com".';

export const WILDCARD_BASE_TOO_SHORT_MESSAGE =
	'A wildcard base domain must contain at least two labels (e.g. "example.com").';

export type WildcardBaseResult =
	| { base: string | null; error?: undefined }
	| { base?: undefined; error: string };

/**
 * Canonical storage form for a user-owned wildcard base domain.
 *
 * Generated domains are concrete hosts (`myapp-1a2b3c.<base>`), so the base is
 * stored BARE — `apps.example.com`, exactly like `server.defaultDomain` — and
 * fed straight into `generateRandomDomain({ baseDomain })`. Users think in
 * wildcards though, so `*.apps.example.com` is accepted as input and normalized
 * by stripping the leading `*.`; the UI renders the stored value back with the
 * `*.` prefix (see `formatWildcardBaseDomain`).
 *
 * Returns `{ base }` for a valid input, `{ base: null }` for an empty input
 * (meaning "cleared"), or `{ error }` with a user-facing message.
 *
 * Rejected on purpose:
 * - prefix patterns (`*-apps.example.com`): they would need per-router regexp
 *   rewriting on every generated host, which v1 does not do.
 * - multi-level wildcards (`**.example.com`) and asterisks anywhere but the
 *   leading label.
 * - single-label bases (`localhost`): Let's Encrypt cannot issue for them and
 *   `generateRandomDomain` would emit a host with no registrable domain.
 */
export const normalizeWildcardBaseDomain = (
	input: string | null | undefined,
): WildcardBaseResult => {
	const normalized = (input ?? "").trim().toLowerCase();

	if (!normalized) {
		return { base: null };
	}

	if (normalized.startsWith("**.")) {
		return { error: WILDCARD_BASE_MULTI_LEVEL_MESSAGE };
	}

	const candidate = normalized.startsWith("*.")
		? normalized.slice(2)
		: normalized;

	if (candidate.includes("*")) {
		// "*-apps.example.com" is a prefix pattern (the asterisk covers part of a
		// label); anything else with a stray asterisk is simply misplaced.
		return normalized.startsWith("*")
			? { error: WILDCARD_BASE_PREFIX_PATTERN_MESSAGE }
			: { error: WILDCARD_BASE_MISPLACED_MESSAGE };
	}

	const hostError = getDomainHostError(candidate);
	if (hostError) {
		return { error: hostError };
	}

	if (!candidate.includes(".")) {
		return { error: WILDCARD_BASE_TOO_SHORT_MESSAGE };
	}

	return { base: candidate };
};

/**
 * Display form for a stored (bare) base domain: `apps.example.com` ->
 * `*.apps.example.com`. Empty/null bases render as an empty string.
 */
export const formatWildcardBaseDomain = (
	base: string | null | undefined,
): string => (base ? `*.${base}` : "");
