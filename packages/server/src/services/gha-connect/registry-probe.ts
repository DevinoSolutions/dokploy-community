import type { ApiFetch, ApiResponse } from "./actions-api";

/**
 * Acceptance rule 4: every image digest of a release must be served by the
 * registry with the same `Docker-Content-Digest`. One `HEAD /v2/<name>/manifests/<digest>`
 * per image (plus a token request when the registry asks for one). The GitHub
 * Packages API is never used.
 */

export type ProbeResult =
	| { kind: "ok"; digest: string | null }
	| { kind: "not-found" }
	| { kind: "unreachable"; status: number }
	/**
	 * The registry answered but would not let this Dokploy read the image (401 or 403 after the
	 * token exchange, a Basic challenge with no saved login, a token endpoint that is not https).
	 * Not a network problem: asking again changes nothing until a login is saved or fixed.
	 */
	| { kind: "denied"; status: number; reason: string };

export interface RegistryProbe {
	headDigest(input: {
		host: string;
		name: string;
		digest: string;
	}): Promise<ProbeResult>;
}

/** How to reach a registry host; null means anonymous HTTPS. */
export interface RegistryAccess {
	baseUrl: string;
	username: string;
	password: string;
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const NAME =
	/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

const basic = (access: RegistryAccess | null): Record<string, string> =>
	access
		? {
				Authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString("base64")}`,
			}
		: {};

/** `Bearer realm="...",service="...",scope="..."` as a record; null for any other scheme. */
export const parseBearerChallenge = (
	header: string | null,
): Record<string, string> | null => {
	if (!header || !/^bearer\s/i.test(header)) return null;
	const out: Record<string, string> = {};
	for (const match of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) {
		if (match[1] && match[2] !== undefined)
			out[match[1].toLowerCase()] = match[2];
	}
	return out.realm ? out : null;
};

export const createRegistryProbe = (deps: {
	fetch: ApiFetch;
	/** Credentials this Dokploy holds for a registry host (its Registry settings), or null. */
	loadAccess: (host: string) => Promise<RegistryAccess | null>;
}): RegistryProbe => ({
	async headDigest({ host, name, digest }) {
		if (!HOST.test(host) || !NAME.test(name) || !DIGEST.test(digest)) {
			return { kind: "not-found" };
		}
		const access = await deps.loadAccess(host);
		const base = (access?.baseUrl ?? `https://${host}`).replace(/\/+$/, "");
		const url = `${base}/v2/${name}/manifests/${digest}`;
		const head = (extra: Record<string, string>) =>
			deps.fetch(url, {
				method: "HEAD",
				headers: {
					Accept: MANIFEST_TYPES,
					"User-Agent": "dokploy-community",
					...extra,
				},
			});

		const denied = (status: number, why: string): ProbeResult => ({
			kind: "denied",
			status,
			reason: access
				? `the saved login for ${host} did not work: the registry ${why}`
				: `Dokploy has no saved login for ${host} and the registry ${why}`,
		});

		let response: ApiResponse;
		try {
			response = await head(basic(access));
			if (response.status === 401) {
				const challenge = parseBearerChallenge(
					response.headers.get("www-authenticate"),
				);
				if (challenge?.realm) {
					const realm = new URL(challenge.realm);
					// The token endpoint must be https (or the registry's own http base):
					// the credential is never sent to a plain-http foreign host.
					if (realm.protocol !== "https:" && !base.startsWith("http://")) {
						return denied(
							401,
							"asked for a token over plain http, which is never used",
						);
					}
					if (challenge.service)
						realm.searchParams.set("service", challenge.service);
					realm.searchParams.set(
						"scope",
						challenge.scope ?? `repository:${name}:pull`,
					);
					const tokenResponse = await deps.fetch(realm.toString(), {
						method: "GET",
						headers: { "User-Agent": "dokploy-community", ...basic(access) },
					});
					if (tokenResponse.status === 401 || tokenResponse.status === 403) {
						return denied(tokenResponse.status, "refused the token request");
					}
					if (!tokenResponse.ok) {
						return { kind: "unreachable", status: tokenResponse.status };
					}
					const body = (await tokenResponse.json().catch(() => null)) as {
						token?: unknown;
						access_token?: unknown;
					} | null;
					const token =
						typeof body?.token === "string"
							? body.token
							: typeof body?.access_token === "string"
								? body.access_token
								: null;
					if (!token) return denied(401, "gave no token");
					response = await head({ Authorization: `Bearer ${token}` });
				}
			}
		} catch {
			return { kind: "unreachable", status: 0 };
		}
		if (response.status === 404) return { kind: "not-found" };
		if (response.status === 401 || response.status === 403) {
			return denied(response.status, "refused the request");
		}
		if (!response.ok) return { kind: "unreachable", status: response.status };
		return {
			kind: "ok",
			digest: response.headers.get("docker-content-digest"),
		};
	},
});
