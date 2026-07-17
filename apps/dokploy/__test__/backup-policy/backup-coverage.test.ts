import { describe, expect, it } from "vitest";
import {
	classifyDbImage,
	extractComposeChildren,
	isComposeVolumeCovered,
	isProductionEnvironment,
	isServiceShownByDefault,
} from "@/lib/backup-coverage";

describe("classifyDbImage", () => {
	it("classifies official database images", () => {
		expect(classifyDbImage("postgres")).toBe("postgres");
		expect(classifyDbImage("postgres:16-alpine")).toBe("postgres");
		expect(classifyDbImage("mysql:8")).toBe("mysql");
		expect(classifyDbImage("mariadb:11")).toBe("mariadb");
		expect(classifyDbImage("mongo:7")).toBe("mongo");
		expect(classifyDbImage("redis:7-alpine")).toBe("redis");
	});

	it("classifies namespaced and registry-prefixed images", () => {
		expect(classifyDbImage("bitnami/postgresql:16")).toBe("postgres");
		expect(classifyDbImage("ghcr.io/acme/postgres:16")).toBe("postgres");
		expect(classifyDbImage("registry.local:5000/team/mysql:8")).toBe("mysql");
		expect(classifyDbImage("supabase/postgres:15.1.0")).toBe("postgres");
	});

	it("handles digests and tags without confusing registry ports", () => {
		expect(classifyDbImage("postgres@sha256:deadbeef")).toBe("postgres");
		expect(classifyDbImage("registry.local:5000/valkey/valkey:8")).toBe(
			"redis",
		);
	});

	it("classifies redis-family alternatives as redis", () => {
		expect(classifyDbImage("valkey/valkey:8")).toBe("redis");
		expect(classifyDbImage("docker.dragonflydb.io/dragonflydb/dragonfly")).toBe(
			"redis",
		);
		expect(classifyDbImage("eqalpha/keydb")).toBe("redis");
	});

	it("prefers mongo/mariadb over the mysql-family patterns", () => {
		expect(classifyDbImage("percona/percona-server-mongodb:7")).toBe("mongo");
		expect(classifyDbImage("percona/percona-server:8")).toBe("mysql");
		expect(classifyDbImage("mariadb:lts")).toBe("mariadb");
	});

	it("classifies postgres-family and libsql variants", () => {
		expect(classifyDbImage("postgis/postgis:16-3.4")).toBe("postgres");
		expect(classifyDbImage("timescale/timescaledb:latest-pg16")).toBe(
			"postgres",
		);
		expect(classifyDbImage("pgvector/pgvector:pg16")).toBe("postgres");
		expect(classifyDbImage("ghcr.io/tursodatabase/libsql-server")).toBe(
			"libsql",
		);
	});

	it("returns null for non-database images and empty input", () => {
		expect(classifyDbImage("nginx:alpine")).toBeNull();
		expect(classifyDbImage("ghcr.io/acme/web-app:1.2.3")).toBeNull();
		expect(classifyDbImage("node:22-alpine")).toBeNull();
		expect(classifyDbImage("")).toBeNull();
		expect(classifyDbImage(null)).toBeNull();
		expect(classifyDbImage(undefined)).toBeNull();
	});
});

describe("isProductionEnvironment", () => {
	it("matches the backup-policy production preset convention", () => {
		expect(isProductionEnvironment("production")).toBe(true);
		expect(isProductionEnvironment("Production")).toBe(true);
		expect(isProductionEnvironment(" production ")).toBe(true);
		expect(isProductionEnvironment("prod")).toBe(false);
		expect(isProductionEnvironment("staging")).toBe(false);
	});
});

describe("isServiceShownByDefault", () => {
	it("shows everything in production environments", () => {
		expect(
			isServiceShownByDefault(
				{ type: "application", hasVolumes: false },
				"production",
			),
		).toBe(true);
		expect(
			isServiceShownByDefault(
				{ type: "compose", hasVolumes: false },
				"Production",
			),
		).toBe(true);
	});

	it("always shows databases in non-production environments", () => {
		for (const type of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"redis",
			"libsql",
		] as const) {
			expect(
				isServiceShownByDefault({ type, hasVolumes: false }, "staging"),
			).toBe(true);
		}
	});

	it("shows non-prod applications/compose only when they have volumes", () => {
		expect(
			isServiceShownByDefault(
				{ type: "application", hasVolumes: true },
				"staging",
			),
		).toBe(true);
		expect(
			isServiceShownByDefault(
				{ type: "application", hasVolumes: false },
				"staging",
			),
		).toBe(false);
		expect(
			isServiceShownByDefault({ type: "compose", hasVolumes: true }, "dev"),
		).toBe(true);
		expect(
			isServiceShownByDefault({ type: "compose", hasVolumes: false }, "dev"),
		).toBe(false);
	});
});

describe("extractComposeChildren", () => {
	it("extracts services with images and named volumes (short syntax)", () => {
		const children = extractComposeChildren({
			services: {
				web: { image: "ghcr.io/acme/web:1", volumes: ["./src:/app"] },
				db: {
					image: "postgres:16",
					volumes: ["db-data:/var/lib/postgresql/data", "/etc/tz:/etc/tz:ro"],
				},
			},
			volumes: { "db-data": null },
		});
		expect(children).toEqual([
			{ name: "web", image: "ghcr.io/acme/web:1", dbKind: null, volumes: [] },
			{
				name: "db",
				image: "postgres:16",
				dbKind: "postgres",
				volumes: ["db-data"],
			},
		]);
	});

	it("supports long-syntax volume entries and skips binds/anonymous", () => {
		const children = extractComposeChildren({
			services: {
				cache: {
					image: "redis:7",
					volumes: [
						{ type: "volume", source: "cache-data", target: "/data" },
						{ type: "bind", source: "./conf", target: "/conf" },
						"/data", // anonymous volume
						"~/host:/container",
						"$HOME/host:/container",
					],
				},
			},
		});
		expect(children).toEqual([
			{
				name: "cache",
				image: "redis:7",
				dbKind: "redis",
				volumes: ["cache-data"],
			},
		]);
	});

	it("deduplicates repeated volume sources", () => {
		const children = extractComposeChildren({
			services: {
				app: {
					image: "node:22",
					volumes: ["shared:/a", "shared:/b"],
				},
			},
		});
		expect(children[0]?.volumes).toEqual(["shared"]);
	});

	it("tolerates services without image or volumes", () => {
		const children = extractComposeChildren({
			services: { built: { build: "." } },
		});
		expect(children).toEqual([
			{ name: "built", image: null, dbKind: null, volumes: [] },
		]);
	});

	it("returns an empty list for malformed documents", () => {
		expect(extractComposeChildren(null)).toEqual([]);
		expect(extractComposeChildren("not yaml objects")).toEqual([]);
		expect(extractComposeChildren({})).toEqual([]);
		expect(extractComposeChildren({ services: [] })).toEqual([]);
		expect(extractComposeChildren({ services: { broken: null } })).toEqual([]);
		expect(
			extractComposeChildren({ services: { odd: { volumes: "no" } } }),
		).toEqual([{ name: "odd", image: null, dbKind: null, volumes: [] }]);
	});
});

describe("isComposeVolumeCovered", () => {
	it("matches exact volume names", () => {
		expect(isComposeVolumeCovered("db-data", ["db-data"])).toBe(true);
	});

	it("matches stack-prefixed deployed volume names", () => {
		expect(isComposeVolumeCovered("db-data", ["myapp-abc123_db-data"])).toBe(
			true,
		);
	});

	it("does not match unrelated names", () => {
		expect(isComposeVolumeCovered("db-data", [])).toBe(false);
		expect(isComposeVolumeCovered("db-data", ["other"])).toBe(false);
		expect(isComposeVolumeCovered("db-data", ["db-data-old"])).toBe(false);
	});
});
