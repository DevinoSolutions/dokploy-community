/**
 * Inputs of the golden `getBuildComposeCommand` fixture
 * (`__fixtures__/build-command-golden.json`). The fixture holds the exact
 * strings the builder produced BEFORE the deploy guardrails existed, so a
 * compose without guardrails is proven byte-identical to what it always got.
 *
 * `serverId` is set on purpose: remote paths are the fixed `/etc/dokploy/...`
 * whatever machine the test runs on.
 */
export const GOLDEN_BASE_COMPOSE = {
	appName: "my-app",
	sourceType: "git",
	command: "",
	composePath: "./docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: "server-1",
	env: "A=1",
	createEnvFile: true,
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
};

export const GOLDEN_REMOTE_BUILD = {
	images: [
		{ service: "web", image: "registry.example/web:1" },
		{ service: "worker", image: "registry.example/worker:1" },
	],
	servingHostLabel: "the serving host",
};

export interface GoldenCase {
	overrides: Record<string, unknown>;
	options: { freshVolumes?: boolean; remoteBuild?: boolean };
}

export const GOLDEN_CASES: Record<string, GoldenCase> = {
	compose: { overrides: {}, options: {} },
	composeNoEnvFile: { overrides: { createEnvFile: false }, options: {} },
	composePullAlways: {
		overrides: { pullImagesOnDeploy: true },
		options: {},
	},
	composeFreshVolumes: { overrides: {}, options: { freshVolumes: true } },
	composeIsolated: {
		overrides: { isolatedDeployment: true, isolatedNetworkMtu: 1400 },
		options: {},
	},
	composeCustomCommand: {
		overrides: { command: "compose up -d --build" },
		options: {},
	},
	stack: { overrides: { composeType: "stack" }, options: {} },
	stackIsolated: {
		overrides: { composeType: "stack", isolatedDeployment: true },
		options: {},
	},
	buildServer: {
		overrides: { buildServerId: "build-1", buildRegistryId: "reg-1" },
		options: { remoteBuild: true },
	},
	buildServerIsolated: {
		overrides: {
			buildServerId: "build-1",
			buildRegistryId: "reg-1",
			isolatedDeployment: true,
		},
		options: { remoteBuild: true },
	},
};
