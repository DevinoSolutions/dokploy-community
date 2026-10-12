import { trimTrailingSlashes } from "@dokploy/server/utils/integrations/base-url";
import { parseScalewayRef } from "@dokploy/server/utils/vault/scaleway";
import { describe, expect, it } from "vitest";

const RUN = 100_000;
// The quadratic `/\/+$/` took many seconds on these inputs; the linear trim is
// instant, so a generous bound still catches a regression.
const MAX_MS = 500;

const timed = <T>(fn: () => T) => {
	const start = performance.now();
	const result = fn();
	return { result, ms: performance.now() - start };
};

describe("trailing slash trimming stays linear", () => {
	it("handles a long run of slashes followed by a non-slash", () => {
		const input = `${"/".repeat(RUN)}x`;
		const { result, ms } = timed(() => trimTrailingSlashes(input));
		expect(result).toBe(input);
		expect(ms).toBeLessThan(MAX_MS);
	});

	it("handles a string that ends with a long run of slashes", () => {
		const { result, ms } = timed(() =>
			trimTrailingSlashes(`https://example.com${"/".repeat(RUN)}`),
		);
		expect(result).toBe("https://example.com");
		expect(ms).toBeLessThan(MAX_MS);
	});

	it("keeps the Scaleway ref parser linear on both shapes", () => {
		const trailing = timed(() =>
			parseScalewayRef(`a${"/".repeat(RUN)}secret:field`),
		);
		expect(trailing.result).toEqual({
			path: "/a",
			name: "secret",
			field: "field",
		});
		expect(trailing.ms).toBeLessThan(MAX_MS);

		const leading = timed(() => parseScalewayRef(`${"/".repeat(RUN)}x/secret`));
		expect(leading.result.name).toBe("secret");
		expect(leading.ms).toBeLessThan(MAX_MS);
	});

	it("still trims like the old regex", () => {
		expect(trimTrailingSlashes("a/b///")).toBe("a/b");
		expect(trimTrailingSlashes("///")).toBe("");
		expect(trimTrailingSlashes("")).toBe("");
		expect(trimTrailingSlashes("a//b")).toBe("a//b");
	});
});
