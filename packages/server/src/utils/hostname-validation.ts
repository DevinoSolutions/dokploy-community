// Valid hostname per RFC 1123: labels of letters, digits and hyphens
// (no leading/trailing hyphen), separated by dots. Underscores are rejected
// because Let's Encrypt refuses to issue certificates for them.
export const VALID_HOSTNAME_REGEX =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export const INVALID_HOSTNAME_MESSAGE =
	"Invalid domain name. Use only letters, numbers, hyphens and dots (e.g. example.com). Underscores are not allowed.";

export const WILDCARD_START_MESSAGE =
	"Wildcard domains must start with '*.' (e.g., '*.example.com' or '*.sub.example.com')";

export const WILDCARD_SINGLE_MESSAGE =
	"Only one wildcard is allowed per domain";

/**
 * Wildcard-aware host validation shared by the domain form schemas and the
 * API input schemas (apiCreateDomain/apiUpdateDomain inherit it via the
 * field-level `host` checks, which survive drizzle-zod's createInsertSchema
 * and .pick() — object-level superRefines do not).
 *
 * - Non-wildcard hosts must match VALID_HOSTNAME_REGEX (underscores stay banned).
 * - Wildcard hosts must be exactly "*." followed by a valid hostname:
 *   a single leading asterisk only, so "bad*.x.com", "a.*.b.com", "*.*.com",
 *   "**.example.com", bare "*" and "*." are all rejected.
 *
 * Returns null when the host is valid, otherwise the error message to surface.
 */
export const getDomainHostError = (host: string): string | null => {
	if (!host.includes("*")) {
		return VALID_HOSTNAME_REGEX.test(host) ? null : INVALID_HOSTNAME_MESSAGE;
	}
	if (!host.startsWith("*.")) {
		return WILDCARD_START_MESSAGE;
	}
	if (host.includes("*", 1)) {
		return WILDCARD_SINGLE_MESSAGE;
	}
	return VALID_HOSTNAME_REGEX.test(host.slice(2))
		? null
		: INVALID_HOSTNAME_MESSAGE;
};

export const isValidDomainHost = (host: string): boolean =>
	getDomainHostError(host) === null;

/**
 * Builds the anchored Go regexp for a Traefik v3 `HostRegexp(...)` rule from a
 * validated wildcard host, e.g. "*.wild.devino.ca" ->
 * "^[a-zA-Z0-9-]+\.wild\.devino\.ca\z".
 *
 * Traefik v3 takes a plain Go (RE2) regexp here — the v2
 * "{subdomain:[a-zA-Z0-9-]+}" named-group syntax is invalid in v3 and produces
 * a router that never matches. The literal remainder is regexp-escaped, and
 * the wildcard matches exactly one DNS label (same scope as a wildcard cert).
 * `\z` (RE2 end-of-text, equivalent to `$` here) is used instead of `$` so the
 * rule stays inert when embedded in a docker-compose label, where a bare `$`
 * trips compose variable interpolation.
 */
export const wildcardHostRegexp = (host: string): string => {
	const remainder = host.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `^[a-zA-Z0-9-]+\\.${remainder}\\z`;
};
