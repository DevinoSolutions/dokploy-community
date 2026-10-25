import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, isIPv6, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isNonPublicIp } from "@dokploy/server/utils/uptimely/preflight";

/**
 * Where a GitHub Enterprise URL may point. The server calls that host (the App
 * manifest conversion, and every later API call and clone of a stored
 * provider), so an address on the Dokploy host's own network (loopback,
 * private ranges, link-local, cloud metadata) is refused unless an
 * administrator lists the host in DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS, for
 * a GitHub Enterprise Server on a LAN.
 */

export const GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV =
	"DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS";

/** Timeout of every request the server makes to a GitHub instance. */
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/** Timeout of the DNS lookup that precedes the first request. */
export const GITHUB_DNS_TIMEOUT_MS = 5_000;

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

const defaultLookup: HostLookup = (hostname) => lookup(hostname, { all: true });

/** Lower case, no brackets, no trailing dot, the way `URL` writes a hostname. */
const normalizeHost = (value: string): string => {
	let host = value
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	try {
		host = new URL(`https://${value.trim()}`).hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
	} catch {
		// Not a URL host: it can only match itself.
	}
	return host.replace(/\.+$/, "");
};

const warnedAllowlistEntries = new Set<string>();

const warnInvalidAllowlistEntry = (entry: string) => {
	if (warnedAllowlistEntries.has(entry)) return;
	warnedAllowlistEntries.add(entry);
	console.warn(
		`${GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV}: ignoring "${entry}", entries must be bare host names (no scheme, path, port, user, query, escape or wildcard)`,
	);
};

/**
 * The hostnames of a comma-separated allowlist, exact match, case-insensitive.
 * An entry that is not a bare hostname (scheme, path, port, user, query,
 * fragment, backslash, percent escape, wildcard, whitespace inside) is ignored
 * and reported once through `onInvalid`.
 */
export const parseAllowedGithubHosts = (
	raw: string | undefined | null,
	onInvalid: (entry: string) => void = warnInvalidAllowlistEntry,
): Set<string> => {
	const hosts = new Set<string>();
	for (const part of (raw ?? "").split(",")) {
		const entry = part.trim();
		if (entry === "") continue;
		if (/[\s/:@?#\\%*]/.test(entry)) {
			onInvalid(entry);
			continue;
		}
		const host = normalizeHost(entry);
		if (host !== "") hosts.add(host);
	}
	return hosts;
};

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
	const literal = address.replace(/^\[|\]$/g, "").split("%")[0] as string;
	// An IPv6 address is judged in its canonical spelling (compressed, an
	// embedded IPv4 written in hex), so 0:0:0:0:0:ffff:7f00:1 gets the verdict
	// of ::ffff:7f00:1.
	let ip = literal;
	if (isIPv6(literal)) {
		try {
			ip = new URL(`http://[${literal}]/`).hostname.replace(/^\[|\]$/g, "");
		} catch {
			return true;
		}
	}
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
	// ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (SIIT) embed an IPv4 address.
	if ([g0, g1, g2, g3, g4].every((g) => g === 0) && g5 === 0xffff) {
		return isNonPublicIp(embeddedIPv4(g6, g7));
	}
	if ([g0, g1, g2, g3].every((g) => g === 0) && g4 === 0xffff && g5 === 0) {
		return isNonPublicIp(embeddedIPv4(g6, g7));
	}
	// 64:ff9b:1::/48 (local-use NAT64) is not routable on the internet.
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
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
	dnsTimeoutMs?: number;
	/** The host the user typed, when `githubUrl` is a host derived from it. */
	displayHost?: string;
}

const PUBLIC_GITHUB_HOSTS = new Set([
	"github.com",
	"www.github.com",
	"api.github.com",
]);

const lookupWithTimeout = async (
	resolveHost: HostLookup,
	hostname: string,
	timeoutMs: number,
) => {
	const signal = AbortSignal.timeout(timeoutMs);
	let onAbort: (() => void) | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		onAbort = () =>
			reject(new Error(`DNS lookup timed out after ${timeoutMs} ms`));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([resolveHost(hostname), timedOut]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
};

type ResolvedAddress = { address: string; family: number };

/** github.com and its API host: public, never resolved or pinned here. */
export const isPublicGithubHost = (hostname: string): boolean =>
	PUBLIC_GITHUB_HOSTS.has(hostname.replace(/\.+$/, "").toLowerCase());

/**
 * The addresses of `hostname` when it passes the URL policy and every address
 * is a public one; throws a GithubHostError otherwise. Not for allowlisted
 * hosts, which skip the check.
 */
const resolvePublicAddresses = async (
	hostname: string,
	allowedHosts: ReadonlySet<string>,
	options: GithubHostGuardOptions,
): Promise<ResolvedAddress[]> => {
	const shown = options.displayHost ?? hostname;
	const policyError = githubHostPolicyError(hostname, allowedHosts);
	if (policyError) {
		console.warn(`[github] refused host "${hostname}": ${policyError}`);
		throw new GithubHostError(policyError);
	}

	// One message for every reason the name is not usable, so the answer does
	// not tell whether a name exists in the server's internal DNS. The reason
	// goes to the log, without the addresses.
	const refuse = (reason: string) => {
		console.warn(`[github] refused host "${hostname}": ${reason}`);
		return new GithubHostError(
			hostNotAccepted(shown, "does not resolve to a public address"),
		);
	};

	let addresses: ResolvedAddress[];
	try {
		addresses = await lookupWithTimeout(
			options.resolveHost ?? defaultLookup,
			hostname,
			options.dnsTimeoutMs ?? GITHUB_DNS_TIMEOUT_MS,
		);
	} catch (error) {
		throw refuse(
			error instanceof Error
				? `lookup failed (${error.message})`
				: "lookup failed",
		);
	}
	if (addresses.length === 0) throw refuse("no address");
	if (addresses.some(({ address }) => isBlockedGithubAddress(address))) {
		throw refuse("resolves to a non-public address");
	}
	return addresses;
};

/**
 * Throws a GithubHostError unless the server may send requests to the GitHub
 * instance at `githubUrl`: the host passes the URL policy and, unless it is on
 * the allowlist, every address it resolves to is a public one. github.com is
 * not resolved. This is an early, readable refusal; the connection itself is
 * checked and pinned by createPinnedGithubFetch.
 */
export const assertGithubHostReachable = async (
	githubUrl: string,
	options: GithubHostGuardOptions = {},
): Promise<void> => {
	const hostname = new URL(githubUrl).hostname.replace(/\.+$/, "");
	if (isPublicGithubHost(hostname)) return;

	const allowedHosts = options.allowedHosts ?? getAllowedGithubHosts();
	if (allowedHosts.has(hostname.replace(/^\[|\]$/g, ""))) return;

	await resolvePublicAddresses(hostname, allowedHosts, options);
};

// Answered as a 400, which Octokit's retry plugin never repeats (a thrown
// error would reach it as a 500 and be retried); callers recognise the message.
const refusedResponse = (message: string) =>
	new Response(JSON.stringify({ message }), {
		status: 400,
		headers: { "content-type": "application/json" },
	});

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
			return refusedResponse(GITHUB_REDIRECT_REFUSED);
		}
		return response;
	};

export interface PinnedGithubFetchOptions extends GithubHostGuardOptions {
	/** The transport; `https.request` unless a test supplies another. */
	request?: typeof httpsRequest;
}

/** Statuses whose answer has no body, which `Response` refuses to be given. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

const toResponse = (incoming: IncomingMessage, method: string): Response => {
	const headers = new Headers();
	for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
		headers.append(
			incoming.rawHeaders[i] as string,
			incoming.rawHeaders[i + 1] as string,
		);
	}
	const init = {
		status: incoming.statusCode ?? 502,
		statusText: incoming.statusMessage,
		headers,
	};
	if (method === "HEAD" || BODYLESS_STATUSES.has(init.status)) {
		incoming.resume();
		return new Response(null, init);
	}
	return new Response(
		Readable.toWeb(incoming) as unknown as ReadableStream,
		init,
	);
};

/**
 * A fetch for a GitHub instance that is not github.com, for every call the
 * server makes to a provider's stored host. The connection is made here, so the
 * policy applies to the address that is connected to:
 * - the host passes the URL policy (no IP literal, no internal name) unless it
 *   is on the allowlist;
 * - the name is resolved once, by the connection's own lookup (5 seconds), and
 *   unless the host is on the allowlist every address must be a public one;
 *   the connection uses those addresses and no second lookup happens, so a
 *   name that later points elsewhere is not followed;
 * - redirects are refused, and a request times out after 15 seconds.
 * A refusal is answered like a redirect: a 400 whose message is a
 * GithubHostError message. github.com is handed to the global fetch as it is.
 */
export const createPinnedGithubFetch = (
	options: PinnedGithubFetchOptions = {},
): typeof fetch => {
	const transport = options.request ?? httpsRequest;

	const send = async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	): Promise<Response> => {
		const target = new URL(
			input instanceof Request ? input.url : String(input),
		);
		const host = target.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
		if (isPublicGithubHost(host)) return globalThis.fetch(input, init);
		if (target.protocol !== "https:") {
			throw new GithubHostError("Only https is supported for GitHub instances");
		}

		const allowedHosts = options.allowedHosts ?? getAllowedGithubHosts();
		const policyError = githubHostPolicyError(host, allowedHosts);
		if (policyError) {
			console.warn(`[github] refused host "${host}": ${policyError}`);
			throw new GithubHostError(policyError);
		}
		const allowed = allowedHosts.has(host);

		const connectLookup = (
			name: string,
			lookupOptions: { all?: boolean; family?: number | string },
			callback: (...args: unknown[]) => void,
		) => {
			const family =
				lookupOptions.family === 4 || lookupOptions.family === "IPv4"
					? 4
					: lookupOptions.family === 6 || lookupOptions.family === "IPv6"
						? 6
						: 0;
			(allowed
				? lookupWithTimeout(
						options.resolveHost ?? defaultLookup,
						name,
						options.dnsTimeoutMs ?? GITHUB_DNS_TIMEOUT_MS,
					)
				: resolvePublicAddresses(name, allowedHosts, options)
			).then(
				(resolved) => {
					const addresses = resolved.filter(
						(entry) => family === 0 || entry.family === family,
					);
					const first = addresses[0];
					if (!first) {
						callback(
							Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), {
								code: "ENOTFOUND",
							}),
						);
					} else if (lookupOptions.all) {
						callback(null, addresses);
					} else {
						callback(null, first.address, first.family);
					}
				},
				(error: unknown) => callback(error),
			);
		};

		const request = new Request(input, init);
		const body = request.body
			? Buffer.from(await request.arrayBuffer())
			: undefined;
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});
		if (body) headers["content-length"] = String(body.length);

		return await new Promise<Response>((resolve, reject) => {
			const outgoing = transport(
				{
					hostname: host,
					port: target.port === "" ? undefined : Number(target.port),
					path: `${target.pathname}${target.search}`,
					method: request.method,
					headers,
					lookup: connectLookup as unknown as LookupFunction,
					// No shared pool: a socket opened without this lookup is never reused.
					agent: false,
					signal: AbortSignal.any([
						request.signal,
						AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
					]),
				},
				(incoming) => resolve(toResponse(incoming, request.method)),
			);
			outgoing.once("error", reject);
			outgoing.end(body);
		});
	};

	return createNoRedirectFetch(async (input, init) => {
		try {
			return await send(input, init);
		} catch (error) {
			if (error instanceof GithubHostError) {
				return refusedResponse(error.message);
			}
			throw error;
		}
	});
};

/**
 * Git argument for a clone, fetch or submodule update from a GitHub instance
 * that is not github.com: git answers a redirect with an error instead of
 * following it to another host (its default follows one for the first request).
 */
export const GIT_NO_REDIRECTS_CONFIG = "-c http.followRedirects=false";

/** The text with every IPv4 and IPv6 address replaced, for the server log. */
export const redactAddresses = (text: string): string =>
	text
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<address>")
		.replace(
			/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi,
			"<address>",
		);

/**
 * The message of a refusal by the host policy, or null for any other error.
 * The policy errors reach a caller as a GithubHostError or, from inside
 * Octokit, as a 400 that carries the same message.
 */
export const githubHostRefusalMessage = (error: unknown): string | null => {
	if (error instanceof GithubHostError) return error.message;
	const { status, message } = (error ?? {}) as {
		status?: unknown;
		message?: unknown;
	};
	if (
		status === 400 &&
		typeof message === "string" &&
		(message === GITHUB_REDIRECT_REFUSED ||
			message.includes(GITHUB_ENTERPRISE_ALLOWED_HOSTS_ENV))
	) {
		return message;
	}
	return null;
};

/**
 * Options for an Octokit that talks to a GitHub instance the user named. The
 * fetch is `baseFetch` without redirects, or, when none is given, the pinned
 * fetch.
 */
export const githubInstanceRequestOptions = (
	baseFetch?: typeof fetch,
	guard: GithubHostGuardOptions = {},
): {
	fetch: typeof fetch;
	redirect: "manual";
	signal: AbortSignal;
} => ({
	fetch: baseFetch
		? createNoRedirectFetch(baseFetch)
		: createPinnedGithubFetch(guard),
	redirect: "manual",
	signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
});
