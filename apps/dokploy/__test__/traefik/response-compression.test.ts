import type { FileConfig, MainTraefikConfig } from "@dokploy/server";
import {
	applyResponseCompressionToMainConfig,
	applyResponseCompressionToMiddlewaresConfig,
	isResponseCompressionEnabledInConfig,
	RESPONSE_COMPRESSION_MIDDLEWARE,
} from "@dokploy/server";
import { describe, expect, test } from "vitest";

const COMPRESS_REF = `${RESPONSE_COMPRESSION_MIDDLEWARE}@file`;

const baseMainConfig = (): MainTraefikConfig => ({
	entryPoints: {
		web: {
			address: ":80",
		},
		websecure: {
			address: ":443",
			http3: {
				advertisedPort: 443,
			},
			http: {
				tls: {
					certResolver: "letsencrypt",
				},
			},
		},
	},
});

describe("applyResponseCompressionToMainConfig", () => {
	test("enable attaches compress@file to web and websecure entry points", () => {
		const config = applyResponseCompressionToMainConfig(baseMainConfig(), true);

		expect(config.entryPoints?.web?.http?.middlewares).toContain(COMPRESS_REF);
		expect(config.entryPoints?.websecure?.http?.middlewares).toContain(
			COMPRESS_REF,
		);
	});

	test("enable preserves existing entry point http settings (tls)", () => {
		const config = applyResponseCompressionToMainConfig(baseMainConfig(), true);

		expect(config.entryPoints?.websecure?.http?.tls?.certResolver).toBe(
			"letsencrypt",
		);
	});

	test("enable is idempotent (no duplicated middleware refs)", () => {
		const once = applyResponseCompressionToMainConfig(baseMainConfig(), true);
		const twice = applyResponseCompressionToMainConfig(once, true);

		const webMiddlewares = twice.entryPoints?.web?.http?.middlewares || [];
		expect(
			webMiddlewares.filter((middleware) => middleware === COMPRESS_REF),
		).toHaveLength(1);
	});

	test("enable keeps middlewares added by the user", () => {
		const config = baseMainConfig();
		config.entryPoints!.web!.http = {
			middlewares: ["my-custom@file"],
		};

		const updated = applyResponseCompressionToMainConfig(config, true);

		expect(updated.entryPoints?.web?.http?.middlewares).toEqual([
			"my-custom@file",
			COMPRESS_REF,
		]);
	});

	test("disable removes the ref and cleans up an empty http block", () => {
		const enabled = applyResponseCompressionToMainConfig(
			baseMainConfig(),
			true,
		);
		const disabled = applyResponseCompressionToMainConfig(enabled, false);

		// web had no other http settings, so the block is removed entirely
		expect(disabled.entryPoints?.web?.http).toBeUndefined();
		// websecure keeps its tls settings
		expect(disabled.entryPoints?.websecure?.http?.middlewares).toBeUndefined();
		expect(disabled.entryPoints?.websecure?.http?.tls?.certResolver).toBe(
			"letsencrypt",
		);
	});

	test("disable keeps middlewares added by the user", () => {
		const config = baseMainConfig();
		config.entryPoints!.web!.http = {
			middlewares: ["my-custom@file", COMPRESS_REF],
		};

		const updated = applyResponseCompressionToMainConfig(config, false);

		expect(updated.entryPoints?.web?.http?.middlewares).toEqual([
			"my-custom@file",
		]);
	});

	test("missing entry points are ignored gracefully", () => {
		const config: MainTraefikConfig = {
			entryPoints: {
				custom: { address: ":9000" },
			},
		};

		const updated = applyResponseCompressionToMainConfig(config, true);

		expect(updated.entryPoints?.custom?.http).toBeUndefined();
	});
});

describe("applyResponseCompressionToMiddlewaresConfig", () => {
	test("enable defines the compress middleware, keeping existing ones", () => {
		const config: FileConfig = {
			http: {
				middlewares: {
					"redirect-to-https": {
						redirectScheme: {
							scheme: "https",
							permanent: true,
						},
					},
				},
			},
		};

		const updated = applyResponseCompressionToMiddlewaresConfig(config, true);

		expect(
			updated.http?.middlewares?.[RESPONSE_COMPRESSION_MIDDLEWARE],
		).toEqual({ compress: {} });
		expect(updated.http?.middlewares?.["redirect-to-https"]).toBeDefined();
	});

	test("enable initializes an empty config", () => {
		const updated = applyResponseCompressionToMiddlewaresConfig({}, true);

		expect(
			updated.http?.middlewares?.[RESPONSE_COMPRESSION_MIDDLEWARE],
		).toEqual({ compress: {} });
	});

	test("disable removes only the compress middleware", () => {
		const config = applyResponseCompressionToMiddlewaresConfig(
			{
				http: {
					middlewares: {
						"redirect-to-https": {
							redirectScheme: {
								scheme: "https",
								permanent: true,
							},
						},
					},
				},
			},
			true,
		);

		const updated = applyResponseCompressionToMiddlewaresConfig(config, false);

		expect(
			updated.http?.middlewares?.[RESPONSE_COMPRESSION_MIDDLEWARE],
		).toBeUndefined();
		expect(updated.http?.middlewares?.["redirect-to-https"]).toBeDefined();
	});
});

describe("isResponseCompressionEnabledInConfig", () => {
	test("returns false for null or empty configs", () => {
		expect(isResponseCompressionEnabledInConfig(null)).toBe(false);
		expect(isResponseCompressionEnabledInConfig({})).toBe(false);
	});

	test("returns false for the default config", () => {
		expect(isResponseCompressionEnabledInConfig(baseMainConfig())).toBe(false);
	});

	test("returns true after enabling", () => {
		const config = applyResponseCompressionToMainConfig(baseMainConfig(), true);
		expect(isResponseCompressionEnabledInConfig(config)).toBe(true);
	});

	test("returns true when only one entry point has the middleware", () => {
		const config = baseMainConfig();
		config.entryPoints!.websecure!.http = {
			...config.entryPoints!.websecure!.http,
			middlewares: [COMPRESS_REF],
		};
		expect(isResponseCompressionEnabledInConfig(config)).toBe(true);
	});

	test("returns false again after disabling", () => {
		const enabled = applyResponseCompressionToMainConfig(
			baseMainConfig(),
			true,
		);
		const disabled = applyResponseCompressionToMainConfig(enabled, false);
		expect(isResponseCompressionEnabledInConfig(disabled)).toBe(false);
	});
});
