import { db } from "@dokploy/server/db";
import { buildDokployLabels } from "@dokploy/server/utils/docker/dokploy-labels";
import { addDomainToCompose } from "@dokploy/server/utils/docker/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

// v0.31.0-community.2: the `dokploy.*` metadata labels change docker compose's
// config hash, so writing them into every compose recreated every container
// (databases included) on the first deploy after the upgrade. They are only
// written when a telemetry agent on the compose's host reads them.

const composeFile = `
services:
  db:
    image: postgres:16
    labels:
      custom: keep
  cache:
    image: redis:7
    labels:
      - custom=keep
  worker:
    image: alpine:latest
`;

const environment = {
	environmentId: "env-1",
	name: "production",
	projectId: "project-1",
	project: { name: "shop", organizationId: "org-1" },
};

const makeCompose = (extra: Record<string, unknown> = {}) =>
	({
		appName: "labels-stack",
		composeFile,
		composeId: "compose-1",
		name: "labels-stack",
		composePath: "./docker-compose.yml",
		composeType: "docker-compose",
		environment,
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		randomize: false,
		serverId: null,
		sourceType: "raw",
		suffix: "",
		...extra,
	}) as unknown as Parameters<typeof addDomainToCompose>[0];

// The test setup shares one mocked table between `server` and `webServerSettings`.
const findFirst = vi.mocked(db.query.server.findFirst);

const metadataKeys = Object.keys(
	buildDokployLabels({
		organizationId: "org-1",
		projectId: "project-1",
		projectName: "shop",
		environmentId: "env-1",
		environmentName: "production",
		applicationId: "compose-1",
		applicationName: "labels-stack",
		serviceName: "db",
	}),
);

const labelKeys = (labels: unknown): string[] =>
	Array.isArray(labels)
		? labels.map((l: string) => l.slice(0, l.indexOf("=")))
		: Object.keys((labels ?? {}) as Record<string, string>);

const dokployKeysOf = (labels: unknown) =>
	labelKeys(labels).filter((key) => metadataKeys.includes(key));

beforeEach(() => {
	findFirst.mockReset();
	findFirst.mockResolvedValue(undefined as never);
});

describe("compose metadata labels need a telemetry agent on the host", () => {
	const withoutTelemetry: Array<[string, Record<string, unknown>, unknown]> = [
		[
			"a remote server without providers selected",
			{ serverId: "server-1" },
			{ telemetryProviderIds: [] },
		],
		["a remote server row that is gone", { serverId: "server-1" }, undefined],
		["a Dokploy host with no settings row", {}, undefined],
		[
			"a Dokploy host agent that is not configured",
			{},
			{ vectorAgentOrganizationId: null, telemetryProviderIds: [] },
		],
		[
			"a Dokploy host agent owned by another organization",
			{},
			{ vectorAgentOrganizationId: "org-2", telemetryProviderIds: ["tp-1"] },
		],
		[
			"a Dokploy host whose owner organization selected no providers",
			{},
			{ vectorAgentOrganizationId: "org-1", telemetryProviderIds: [] },
		],
	];

	it.each(withoutTelemetry)(
		"adds no label and leaves the file as it was on %s",
		async (_name, extra, row) => {
			findFirst.mockResolvedValue(row as never);

			for (const composeType of ["docker-compose", "stack"]) {
				const converted = await addDomainToCompose(
					makeCompose({ ...extra, composeType }),
					[],
				);

				// The v0.30 / community.51 output: the parsed file, untouched.
				expect(stringify(converted)).toBe(stringify(parse(composeFile)));
				for (const service of Object.values(converted?.services ?? {})) {
					expect(dokployKeysOf(service.labels)).toEqual([]);
					expect(dokployKeysOf(service.deploy?.labels)).toEqual([]);
				}
				expect(converted?.services?.worker).not.toHaveProperty("labels");
				expect(converted?.services?.worker).not.toHaveProperty("deploy");
			}
		},
	);

	it("does not look anything up for a compose without its project loaded", async () => {
		const converted = await addDomainToCompose(
			makeCompose({ environment: undefined, serverId: "server-1" }),
			[],
		);

		expect(findFirst).not.toHaveBeenCalled();
		expect(stringify(converted)).toBe(stringify(parse(composeFile)));
	});

	it("looks the host up once per render", async () => {
		await addDomainToCompose(makeCompose({ serverId: "server-1" }), []);
		await addDomainToCompose(makeCompose(), []);

		expect(findFirst).toHaveBeenCalledTimes(2);
	});

	it("adds the labels on a remote server with providers selected", async () => {
		findFirst.mockResolvedValue({ telemetryProviderIds: ["tp-1"] } as never);

		const converted = await addDomainToCompose(
			makeCompose({ serverId: "server-1" }),
			[],
		);

		for (const [serviceName, service] of Object.entries(
			converted?.services ?? {},
		)) {
			const expected = buildDokployLabels({
				organizationId: "org-1",
				projectId: "project-1",
				projectName: "shop",
				environmentId: "env-1",
				environmentName: "production",
				applicationId: "compose-1",
				applicationName: "labels-stack",
				serviceName,
			});
			const asList = Object.entries(expected).map(([k, v]) => `${k}=${v}`);
			expect(dokployKeysOf(service.labels).sort()).toEqual(
				Object.keys(expected).sort(),
			);
			if (Array.isArray(service.labels)) {
				expect(service.labels).toEqual(expect.arrayContaining(asList));
			} else {
				expect(service.labels).toMatchObject(expected);
			}
			// docker-compose type keeps its labels off `deploy`.
			expect(service.deploy).toBeUndefined();
		}
		expect(converted?.services?.db?.labels).toMatchObject({ custom: "keep" });
	});

	it("adds the labels to the stack deploy labels as well", async () => {
		findFirst.mockResolvedValue({ telemetryProviderIds: ["tp-1"] } as never);

		const converted = await addDomainToCompose(
			makeCompose({ serverId: "server-1", composeType: "stack" }),
			[],
		);

		for (const service of Object.values(converted?.services ?? {})) {
			expect(dokployKeysOf(service.labels).sort()).toEqual(
				[...metadataKeys].sort(),
			);
			expect(dokployKeysOf(service.deploy?.labels).sort()).toEqual(
				[...metadataKeys].sort(),
			);
		}
	});

	it("adds the labels on the Dokploy host for the organization that owns the agent", async () => {
		findFirst.mockResolvedValue({
			vectorAgentOrganizationId: "org-1",
			telemetryProviderIds: ["tp-1"],
		} as never);

		const converted = await addDomainToCompose(makeCompose(), []);

		for (const service of Object.values(converted?.services ?? {})) {
			expect(dokployKeysOf(service.labels).sort()).toEqual(
				[...metadataKeys].sort(),
			);
		}
	});
});
