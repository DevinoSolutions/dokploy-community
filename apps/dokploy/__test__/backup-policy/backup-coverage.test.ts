import { describe, expect, it } from "vitest";
import {
	backupTabForServiceType,
	buildBackupListPrefix,
	buildServiceBackupHref,
	type CoverageFacets,
	classifyDbImage,
	countBackupFiles,
	DATABASE_SERVICE_TYPES,
	EMPTY_COVERAGE_FACETS,
	extractBackupArtifactPath,
	extractComposeChildren,
	hasExplicitFacets,
	isComposeVolumeCovered,
	isEnvironmentShownByFacets,
	isProductionEnvironment,
	isServiceShownByDefault,
	isServiceShownByFacets,
	parseBackupTimestamp,
	serviceMatchesSearch,
	textMatchesQuery,
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

describe("coverage facets", () => {
	const facets = (partial: Partial<CoverageFacets>): CoverageFacets => ({
		...EMPTY_COVERAGE_FACETS,
		...partial,
	});
	const app = { type: "application", hasVolumes: false } as const;
	const appWithVolumes = { type: "application", hasVolumes: true } as const;
	const postgres = { type: "postgres", hasVolumes: false } as const;
	const compose = { type: "compose", hasVolumes: false } as const;

	it("detects explicit selections", () => {
		expect(hasExplicitFacets(EMPTY_COVERAGE_FACETS)).toBe(false);
		expect(hasExplicitFacets(facets({ environmentNames: ["staging"] }))).toBe(
			true,
		);
		expect(hasExplicitFacets(facets({ serviceTypes: ["postgres"] }))).toBe(
			true,
		);
		expect(hasExplicitFacets(facets({ notCoveredOnly: true }))).toBe(true);
	});

	it("falls back to the default rule without explicit facets", () => {
		// Production shows everything; non-prod hides volume-less apps.
		expect(
			isServiceShownByFacets(app, "production", false, EMPTY_COVERAGE_FACETS),
		).toBe(true);
		expect(
			isServiceShownByFacets(app, "staging", false, EMPTY_COVERAGE_FACETS),
		).toBe(false);
		expect(
			isServiceShownByFacets(
				appWithVolumes,
				"staging",
				false,
				EMPTY_COVERAGE_FACETS,
			),
		).toBe(true);
		expect(
			isServiceShownByFacets(postgres, "staging", false, EMPTY_COVERAGE_FACETS),
		).toBe(true);
	});

	it("matches environment names globally, case-insensitively", () => {
		const selection = facets({ environmentNames: ["Staging"] });
		expect(isEnvironmentShownByFacets("staging", selection)).toBe(true);
		expect(isEnvironmentShownByFacets(" STAGING ", selection)).toBe(true);
		expect(isEnvironmentShownByFacets("production", selection)).toBe(false);
		// No selection shows every environment.
		expect(isEnvironmentShownByFacets("anything", EMPTY_COVERAGE_FACETS)).toBe(
			true,
		);
	});

	it("replaces the default rule the moment any facet is explicit", () => {
		// A volume-less staging app is hidden by default but visible once the
		// env-name facet selects staging (no type facet active).
		expect(
			isServiceShownByFacets(
				app,
				"staging",
				false,
				facets({ environmentNames: ["staging"] }),
			),
		).toBe(true);
		// Conversely a production database disappears when only staging is picked.
		expect(
			isServiceShownByFacets(
				postgres,
				"production",
				false,
				facets({ environmentNames: ["staging"] }),
			),
		).toBe(false);
	});

	it("filters by service type, including the Databases group", () => {
		const databasesOnly = facets({ serviceTypes: [...DATABASE_SERVICE_TYPES] });
		for (const type of DATABASE_SERVICE_TYPES) {
			expect(
				isServiceShownByFacets(
					{ type, hasVolumes: false },
					"staging",
					false,
					databasesOnly,
				),
			).toBe(true);
		}
		expect(
			isServiceShownByFacets(app, "production", false, databasesOnly),
		).toBe(false);
		expect(
			isServiceShownByFacets(compose, "production", false, databasesOnly),
		).toBe(false);

		const appsOnly = facets({ serviceTypes: ["application"] });
		expect(isServiceShownByFacets(app, "staging", false, appsOnly)).toBe(true);
		expect(isServiceShownByFacets(postgres, "staging", false, appsOnly)).toBe(
			false,
		);
	});

	it("supports the not-covered-only toggle", () => {
		const uncoveredOnly = facets({ notCoveredOnly: true });
		expect(isServiceShownByFacets(app, "staging", false, uncoveredOnly)).toBe(
			true,
		);
		expect(isServiceShownByFacets(app, "staging", true, uncoveredOnly)).toBe(
			false,
		);
		// The default volume rule no longer applies once the toggle is explicit.
		expect(
			isServiceShownByFacets(postgres, "staging", true, uncoveredOnly),
		).toBe(false);
	});

	it("ANDs facets together while ORing within a facet", () => {
		const combined = facets({
			environmentNames: ["staging", "development"],
			serviceTypes: ["postgres", "redis"],
			notCoveredOnly: true,
		});
		const redis = { type: "redis", hasVolumes: false } as const;
		// Passes every facet.
		expect(isServiceShownByFacets(postgres, "staging", false, combined)).toBe(
			true,
		);
		expect(isServiceShownByFacets(redis, "development", false, combined)).toBe(
			true,
		);
		// Fails exactly one facet each.
		expect(
			isServiceShownByFacets(postgres, "production", false, combined),
		).toBe(false);
		expect(isServiceShownByFacets(app, "staging", false, combined)).toBe(false);
		expect(isServiceShownByFacets(postgres, "staging", true, combined)).toBe(
			false,
		);
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

describe("buildBackupListPrefix", () => {
	it("appends a trailing slash to a bare prefix", () => {
		expect(buildBackupListPrefix("backups")).toBe("backups/");
		expect(buildBackupListPrefix("team/postgres")).toBe("team/postgres/");
	});

	it("strips surrounding whitespace and leading/trailing slashes", () => {
		expect(buildBackupListPrefix("  backups  ")).toBe("backups/");
		expect(buildBackupListPrefix("/backups/")).toBe("backups/");
		expect(buildBackupListPrefix("///team/db///")).toBe("team/db/");
	});

	it("returns an empty string for an empty or slash-only prefix", () => {
		expect(buildBackupListPrefix("")).toBe("");
		expect(buildBackupListPrefix("   ")).toBe("");
		expect(buildBackupListPrefix("/")).toBe("");
	});
});

describe("parseBackupTimestamp", () => {
	it("recovers the date from a dump file name", () => {
		expect(
			parseBackupTimestamp("2026-07-17T12-30-45-123Z.sql.gz")?.toISOString(),
		).toBe("2026-07-17T12:30:45.123Z");
		expect(
			parseBackupTimestamp("2026-01-02T03-04-05-006Z.bson.gz")?.toISOString(),
		).toBe("2026-01-02T03:04:05.006Z");
	});

	it("finds the timestamp even under a prefixed path", () => {
		expect(
			parseBackupTimestamp(
				"team/db/2026-07-17T12-30-45-123Z.sql.gz",
			)?.toISOString(),
		).toBe("2026-07-17T12:30:45.123Z");
	});

	it("returns null when there is no recognizable timestamp", () => {
		expect(parseBackupTimestamp("latest.sql.gz")).toBeNull();
		expect(parseBackupTimestamp("")).toBeNull();
		expect(parseBackupTimestamp("2026-07-17.sql.gz")).toBeNull();
	});
});

describe("countBackupFiles", () => {
	it("counts files and ignores directories", () => {
		expect(
			countBackupFiles([{ IsDir: false }, { IsDir: true }, { IsDir: false }]),
		).toBe(2);
	});

	it("is zero for an empty or directory-only listing", () => {
		expect(countBackupFiles([])).toBe(0);
		expect(countBackupFiles([{ IsDir: true }, { IsDir: true }])).toBe(0);
	});
});

describe("textMatchesQuery", () => {
	it("matches case-insensitively and ignores surrounding whitespace", () => {
		expect(textMatchesQuery("Production API", "api")).toBe(true);
		expect(textMatchesQuery("Production API", "  PROD ")).toBe(true);
		expect(textMatchesQuery("Production API", "staging")).toBe(false);
	});

	it("treats an empty or whitespace-only query as matching everything", () => {
		expect(textMatchesQuery("anything", "")).toBe(true);
		expect(textMatchesQuery("anything", "   ")).toBe(true);
	});
});

describe("serviceMatchesSearch", () => {
	const service = {
		name: "orders-db",
		projectName: "Checkout",
		environmentName: "production",
	};

	it("matches against the service, project, or environment name", () => {
		expect(serviceMatchesSearch(service, "orders")).toBe(true);
		expect(serviceMatchesSearch(service, "checkout")).toBe(true);
		expect(serviceMatchesSearch(service, "prod")).toBe(true);
	});

	it("returns false when nothing matches and true for an empty query", () => {
		expect(serviceMatchesSearch(service, "payments")).toBe(false);
		expect(serviceMatchesSearch(service, "  ")).toBe(true);
	});
});

describe("extractBackupArtifactPath", () => {
	it("pulls the artifact path from a run log for each backup kind", () => {
		expect(
			extractBackupArtifactPath(
				"[date] Streaming...\nUploaded to team/db/2026-07-17T12-30-45-123Z.sql.gz\nBackup done",
			),
		).toBe("team/db/2026-07-17T12-30-45-123Z.sql.gz");
		expect(
			extractBackupArtifactPath("copied :s3:bucket/mongo/dump.bson.gz ok"),
		).toBe(":s3:bucket/mongo/dump.bson.gz");
		expect(
			extractBackupArtifactPath("Transferred: data-2026.tar.gz done"),
		).toBe("data-2026.tar.gz");
		expect(extractBackupArtifactPath("wrote volume-data.tar")).toBe(
			"volume-data.tar",
		);
	});

	it("returns the last artifact when several appear", () => {
		expect(extractBackupArtifactPath("old/a.sql.gz\nnew/b.sql.gz")).toBe(
			"new/b.sql.gz",
		);
	});

	it("strips surrounding quotes and trailing punctuation", () => {
		expect(extractBackupArtifactPath('to "team/db/x.sql.gz".')).toBe(
			"team/db/x.sql.gz",
		);
	});

	it("returns null when no artifact path is present", () => {
		expect(
			extractBackupArtifactPath(
				"[date] Streaming backup to S3...\n[date] Upload completed successfully",
			),
		).toBeNull();
		expect(extractBackupArtifactPath("")).toBeNull();
		expect(extractBackupArtifactPath(null)).toBeNull();
		expect(extractBackupArtifactPath(undefined)).toBeNull();
	});
});

describe("backupTabForServiceType", () => {
	it("uses the dump backups tab for databases and compose", () => {
		for (const type of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"libsql",
			"compose",
		] as const) {
			expect(backupTabForServiceType(type)).toBe("backups");
		}
	});

	it("uses volume-backups for applications and advanced for redis", () => {
		expect(backupTabForServiceType("application")).toBe("volume-backups");
		expect(backupTabForServiceType("redis")).toBe("advanced");
	});
});

describe("buildServiceBackupHref", () => {
	it("links to the service's backups tab", () => {
		expect(
			buildServiceBackupHref({
				type: "postgres",
				projectId: "p1",
				environmentId: "e1",
				serviceId: "s1",
			}),
		).toBe(
			"/dashboard/project/p1/environment/e1/services/postgres/s1?tab=backups",
		);
		expect(
			buildServiceBackupHref({
				type: "application",
				projectId: "p1",
				environmentId: "e1",
				serviceId: "a1",
			}),
		).toBe(
			"/dashboard/project/p1/environment/e1/services/application/a1?tab=volume-backups",
		);
		expect(
			buildServiceBackupHref({
				type: "redis",
				projectId: "p1",
				environmentId: "e1",
				serviceId: "r1",
			}),
		).toBe(
			"/dashboard/project/p1/environment/e1/services/redis/r1?tab=advanced",
		);
	});
});
