import type { ApiFetch } from "@dokploy/server/services/gha-connect/actions-api";

export interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export type Reply = {
	status?: number;
	json?: unknown;
	text?: string;
	bytes?: Uint8Array;
	headers?: Record<string, string>;
};

/**
 * A scripted GitHub: replies by URL substring (first match wins), in the order
 * given, recording every call. A reply may be a function of the call.
 */
export const routedFetch = (
	routes: Array<[string, Reply | ((call: Recorded) => Reply)]>,
) => {
	const calls: Recorded[] = [];
	const fetch: ApiFetch = async (url, init) => {
		const call: Recorded = {
			url,
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body,
		};
		calls.push(call);
		const route = routes.find(([needle]) => url.includes(needle));
		const reply: Reply = route
			? typeof route[1] === "function"
				? route[1](call)
				: route[1]
			: { status: 599, text: `no route for ${url}` };
		const status = reply.status ?? 200;
		const headers = Object.fromEntries(
			Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
			json: async () => reply.json ?? null,
			text: async () => reply.text ?? JSON.stringify(reply.json ?? ""),
			arrayBuffer: async () => {
				const bytes = reply.bytes ?? new Uint8Array();
				return bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer;
			},
		};
	};
	return { fetch, calls };
};
