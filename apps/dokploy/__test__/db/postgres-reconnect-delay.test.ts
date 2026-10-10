import net from "node:net";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * postgres.js schedules a reconnect at `closedDate + backoff - performance.now()`.
 * When a closed pool slot is reused after its backoff window is already over,
 * that is a negative delay and Node prints `TimeoutNegativeWarning` (seen once
 * on production boot). The pnpm patch for postgres@3.4.4 clamps it at zero.
 *
 * The fake server answers the startup handshake and every simple query, and
 * hangs up on the first connection after its first answer.
 */

const message = (type: string, body: Buffer = Buffer.alloc(0)) => {
	const head = Buffer.alloc(5);
	head.write(type, 0, "latin1");
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
};

const AUTH_OK = message("R", Buffer.from([0, 0, 0, 0]));
const READY = message("Z", Buffer.from("I"));
const COMPLETE = message("C", Buffer.from("SELECT 0\0"));

const startFakePostgres = async () => {
	let connections = 0;
	const server = net.createServer((socket) => {
		const first = connections++ === 0;
		let started = false;
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			if (!started) {
				started = true;
				socket.write(Buffer.concat([AUTH_OK, READY]));
				return;
			}
			if (chunk[0] === "Q".charCodeAt(0)) {
				socket.write(Buffer.concat([COMPLETE, READY]));
				if (first) setTimeout(() => socket.destroy(), 10);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	return {
		port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("postgres.js reconnect delay", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never schedules a negative timeout when a closed connection is reused after its backoff", async () => {
		const server = await startFakePostgres();
		const sql = postgres({
			host: "127.0.0.1",
			port: server.port,
			max: 1,
			fetch_types: false,
			connect_timeout: 5,
			// 20ms backoff, long over by the time the slot is reused.
			backoff: () => 0.02,
		});
		const delays: number[] = [];
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms?: number,
			...args: unknown[]
		) => {
			if (typeof ms === "number") delays.push(ms);
			return realSetTimeout(fn, ms, ...args);
		}) as typeof setTimeout);

		try {
			await sql.unsafe("select 1").simple();
			// The server hangs up 10ms after answering; let the backoff pass.
			await wait(150);
			await sql.unsafe("select 1").simple();
		} finally {
			await sql.end({ timeout: 1 });
			await server.close();
		}

		expect(delays.length).toBeGreaterThan(0);
		expect(delays.filter((ms) => ms < 0)).toEqual([]);
	});
});
