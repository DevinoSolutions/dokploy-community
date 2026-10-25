import { lookup } from "node:dns/promises";
import { isIP, isIPv6 } from "node:net";
import { isNonPublicIp } from "@dokploy/server/utils/uptimely/preflight";

/**
 * Where a GitHub Enterprise URL may point. The server POSTs the App manifest
 * conversion to that host, so an address on the Dokploy host's own network
 * (loopback, private ranges, link-local, cloud metadata) is refused unless an
 * administrator lists the host in DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS, for
 * a GitHub Enterprise Server on a LAN.
 */

export const GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV =
	"DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS";

/** Timeout of every request the server makes to a GitHub instance. */
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export const GITHUB_REDIRECT_REFUSED =
	"The GitHub instance answered with a redirect, which is not followed";

export class GithubHostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GithubHostError";
	}
}

type HostLookup = (
	hostname: string,
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: HostLookup = (hostname) =>
	lookup(hostname, { all: true });

/** Lower case, no brackets, no trailing dot, the way `URL` writes a hostname. */
const normalizeHost = (value: string): string => {
	let host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
	try {
		host = new URL(`https://${value.trim()}`).hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
	} catch {
		// Not a URL host: it can only match itself.
	}
	return host.replace(/\.+$/, "");
};

/** The hostnames of a comma-separated allowlist, exact match, case-insensitive. */
export const parseAllowedGithubHosts = (
	raw: string | undefined | null,
): Set<string> =>
	new Set(
		(raw ?? "")
			.split(",")
			.map(normalizeHost)
			.filter((host) => host !== ""),
	);

export const getAllowedGithubHosts = (): Set<string> =>
	parseAllowedGithubHosts(process.env.DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS);

const isInternalHostName = (hostname: string): boolean =>
	hostname === "localhost" || /\.(localhost|local|internal)$/.test(hostname);

const hostNotAccepted = (hostname: string, what: string) =>
	`"${hostname}" ${what}, which is not accepted for a GitHub Enterprise URL. Use the public host name of the instance, or ask an administrator to allow it with ${GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV}.`;

/**
 * The reason a hostname written in a GitHub Enterprise URL is refused, or null.
 * `hostname` is the one `URL` produced (lower case, IPv6 in brackets, no
 * trailing dot), so decimal, octal and hex IPv4 forms are already dotted.
 */
export const githubHostPolicyError = (
	hostname: string,
	allowedHosts: ReadonlySet<string> = getAllowedGithubHosts(),
): string | null => {
	const host = hostname.replace(/^\[|\]$/g, "");
	if (allowedHosts.has(host)) return null;
	if (isIP(host) !== 0) {
		return hostNotAccepted(hostname, "is an IP address");
	}
	if (isInternalHostName(host)) {
		return hostNotAccepted(hostname, "is an internal host name");
	}
	return null;
};

const ipv6Groups = (ip: string): number[] | null => {
	let address = ip.toLowerCase();
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
		];
		address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [
		...head,
		...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
		...tail,
	].map((group) => Number.parseInt(group, 16));
	return groups.length === 8 && groups.every((g) => Number.isInteger(g))
		? groups
		: null;
};

const embeddedIPv4 = (high: number, low: number) =>
	`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * True for an address the Dokploy host must not be made to call: loopback,
 * private, link-local, CGNAT, unique-local, unspecified, multicast and
 * reserved ones, and IPv6 forms that carry such an IPv4 address (mapped,
 * compatible, NAT64, 6to4).
 */
export const isBlockedGithubAddress = (address: string): boolean => {
	const ip = address.replace(/^\[|\]$/g, "").split("%")[0] as string;
	if (isNonPublicIp(ip)) return true;
	if (!isIPv6(ip)) return false;
	const groups = ipv6Groups(ip);
	if (!groups) return true;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	// ::/96 (IPv4-compatible, deprecated), fec0::/10 (site-local).
	if ([g0, g1, g2, g3, g4, g5].every((g) => g === 0)) return true;
	if ((g0 & 0xffc0) === 0xfec0) return true;
	// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address.
	if (g0 === 0x64 && g1 === 0xff9b && [g2, g3, g4, g5].every((g) => g === 0)) {
		return isNonPublicIp(embeddedIPv4(g6, g7));
	}
	if (g0 === 0x2002) return isNonPublicIp(embeddedIPv4(g1, g2));
	return false;
};

export interface GithubHostGuardOptions {
	allowedHosts?: ReadonlySet<string>;
	resolveHost?: HostLookup;
}

const PUBLIC_GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Throws a GithubHostError unless the server may send requests to the GitHub
 * instance at `githubUrl`: the host passes the URL policy and, unless it is on
 * the allowlist, every address it resolves to is a public one. github.com is
 * not resolved. The name is resolved here and again by fetch, so a rebinding
 * race is narrowed, not eliminated.
 */
export const assertGithubHostReachable = async (
	githubUrl: string,
	options: GithubHostGuardOptions = {},
): Promise<void> => {
	const hostname = new URL(githubUrl).hostname.replace(/\.+$/, "");
	if (PUBLIC_GITHUB_HOSTS.has(hostname)) return;

	const allowedHosts = options.allowedHosts ?? getAllowedGithubHosts();
	if (allowedHosts.has(hostname.replace(/^\[|\]$/g, ""))) return;

	const policyError = githubHostPolicyError(hostname, allowedHosts);
	if (policyError) throw new GithubHostError(policyError);

	let addresses: { address: string; family: number }[];
	try {
		addresses = await (options.resolveHost ?? defaultLookup)(hostname);
	} catch {
		throw new GithubHostError(`Could not resolve "${hostname}"`);
	}
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => isBlockedGithubAddress(address))
	) {
		throw new GithubHostError(
			hostNotAccepted(hostname, "resolves to a private or internal address"),
		);
	}
};

/**
 * A fetch that does not follow redirects and refuses a 3xx answer: the
 * address check covers the host that was named, not wherever it points next.
 */
export const createNoRedirectFetch =
	(baseFetch: typeof fetch = globalThis.fetch): typeof fetch =>
	async (input, init) => {
		const response = await baseFetch(input, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			throw new GithubHostError(GITHUB_REDIRECT_REFUSED);
		}
		return response;
	};

/** Options for an Octokit that talks to a GitHub instance the user named. */
export const githubInstanceRequestOptions = (
	baseFetch?: typeof fetch,
): {
	fetch: typeof fetch;
	redirect: "manual";
	signal: AbortSignal;
} => ({
	fetch: createNoRedirectFetch(baseFetch),
	redirect: "manual",
	signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
});
