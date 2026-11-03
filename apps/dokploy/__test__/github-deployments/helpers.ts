import type { FetchLike } from "@dokploy/server/services/github-deployments/device-flow";

export interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

type Reply = {
	status?: number;
	json?: unknown;
	text?: string;
	headers?: Record<string, string>;
};

/** A scripted fetch: replies in order (or by function), recording every call. */
export const scriptedFetch = (
	replies: Array<Reply | ((call: Recorded) => Reply) | Error>,
) => {
	const calls: Recorded[] = [];
	let i = 0;
	const fetch: FetchLike = async (url, init) => {
		const call: Recorded = {
			url,
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body,
		};
		calls.push(call);
		const next = replies[Math.min(i, replies.length - 1)];
		i += 1;
		if (next instanceof Error) throw next;
		const reply = typeof next === "function" ? next(call) : (next as Reply);
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
		};
	};
	return { fetch, calls };
};
