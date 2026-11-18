import { vi } from "vitest";

/**
 * Stand-in for the `@dokploy/server` module in router tests. Names in `named`
 * return the given value; any other name returns one shared `vi.fn()` per name,
 * so a router can import services the test does not care about.
 *
 * Use it from an async factory, because `vi.mock` is hoisted above imports:
 *
 *   vi.mock("@dokploy/server", async () => {
 *     const { createDokployServerMock } = await import(
 *       "../helpers/mock-dokploy-server"
 *     );
 *     return createDokployServerMock({ findApplicationById: mocks.find });
 *   });
 */
export const createDokployServerMock = (
	named: Record<string, unknown> = {},
) => {
	const stubs: Record<string | symbol, unknown> = {};
	const values: Record<string, unknown> = { IS_CLOUD: false, ...named };
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in values) {
				return values[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
};
