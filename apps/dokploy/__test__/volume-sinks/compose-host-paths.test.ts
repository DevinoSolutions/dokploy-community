import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7142: the host paths of a compose file other than `volumes:` (build
// context, develop.watch, env_file, secrets and configs) get the same rules as
// the source of a bind mount.
const mocks = vi.hoisted(() => {
	const table = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
	return {
		query: {
			applications: table(),
			compose: table(),
			libsql: table(),
			mariadb: table(),
			mongo: table(),
			mysql: table(),
			postgres: table(),
			redis: table(),
			mounts: table(),
			volumeBackups: table(),
			patch: table(),
			deployments: table(),
			network: table(),
		},
		warn: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async <T>(value: T) => value,
}));

const { assertComposeVolumesBound, assertComposeFileVolumesBound } =
	await import("@dokploy/server/services/compose-volume-binding");
const { resolveComposeMountedVolumes, resolveComposeFilesMountedVolumes } =
	await import("@dokploy/server/utils/volume-backups/compose-volumes");
const { parse } = await import("yaml");

const APP = "compose-x-AbC123";
const BASE = "/etc/dokploy/compose/app/code";
const STORAGE = "/var/lib/docker/volumes";
const VICTIM = `${STORAGE}/victim_data/_data`;
// A climb from BASE that ends at the root, whatever the depth of BASE.
const UP = "../../../../../../../../../..";

const check = (
	yaml: string,
	{
		env = {},
		strict = false,
	}: { env?: Record<string, string> | null; strict?: boolean } = {},
) => {
	const { forbidden, forbiddenParents, unresolved } =
		resolveComposeMountedVolumes(parse(yaml), {
			appName: APP,
			env,
			strict,
			baseDirs: [BASE],
		});
	return { forbidden, forbiddenParents, unresolved };
};

// Dokploy writes no env file: no variable can be trusted.
const STRICT = { env: null, strict: true };

const clean = { forbidden: [], forbiddenParents: [], unresolved: [] };

const service = (body: string) => `
services:
  web:
    image: nginx
${body}
`;

const composeRow = (composeFile: string, overrides = {}) =>
	({
		composeId: "compose-1",
		appName: APP,
		sourceType: "raw",
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile,
		command: "",
		createEnvFile: true,
		env: "",
		randomize: false,
		suffix: "",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		serverId: null,
		domains: [],
		serviceNetworks: [],
		environment: { env: "", project: { env: "" } },
		...overrides,
	}) as never;

beforeEach(() => {
	vi.clearAllMocks();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
});

describe("build.context", () => {
	it("refuses a context inside Docker's volume storage, in both forms", () => {
		expect(check(service(`    build: ${VICTIM}`)).forbidden).toEqual([
			`build context "${VICTIM}"`,
		]);
		expect(
			check(service(`    build:\n      context: ${VICTIM}`)).forbidden,
		).toEqual([`build context "${VICTIM}"`]);
		expect(
			check(service(`    build:\n      context: ${STORAGE}`)).forbidden,
		).toEqual([`build context "${STORAGE}"`]);
	});

	it("refuses a context that contains the storage", () => {
		for (const parent of ["/", "/var", "/var/lib", "/var/lib/docker"]) {
			expect(check(service(`    build: ${parent}`)).forbiddenParents).toEqual([
				`build context "${parent}"`,
			]);
			expect(
				check(service(`    build:\n      context: ${parent}`)).forbiddenParents,
			).toEqual([`build context "${parent}"`]);
		}
	});

	it("follows a .. climb and odd spellings of the path", () => {
		expect(check(service(`    build: ${UP}${VICTIM}`)).forbidden).toEqual([
			`build context "${UP}${VICTIM}"`,
		]);
		expect(check(service(`    build: ${UP}`)).forbiddenParents).toHaveLength(1);
		expect(
			check(service("    build: /var//lib/./docker/../docker/volumes/"))
				.forbidden,
		).toHaveLength(1);
		expect(
			check(service("    build: /proc/self/root")).forbiddenParents,
		).toHaveLength(1);
	});

	it("checks the default context of a build that names none", () => {
		// `.` is the project directory: the compose's own.
		expect(check(service("    build:\n      dockerfile: Dockerfile"))).toEqual(
			clean,
		);
	});

	it("refuses a context that a variable points into the storage", () => {
		expect(
			check(service("    build: ${SRC}"), { env: { SRC: VICTIM } }).forbidden,
		).toEqual(['build context "${SRC}"']);
		expect(
			check(service("    build:\n      context: $SRC"), {
				env: { SRC: "/" },
			}).forbiddenParents,
		).toEqual(['build context "$SRC"']);
		expect(
			check(service("    build: ${A:-/var}/lib/${B:-docker}/volumes"))
				.forbidden,
		).toHaveLength(1);
	});

	it("refuses what is written before an unresolved variable", () => {
		expect(
			check(service(`    build: ${STORAGE}/\${NAME}/_data`), STRICT).forbidden,
		).toHaveLength(1);
		expect(
			check(service("    build: /var/lib/docker/${NAME}"), STRICT).forbidden,
		).toHaveLength(1);
	});

	it("cannot resolve a .. next to an unresolved variable", () => {
		const result = check(service("    build: ${BASE_DIR}/../.."), STRICT);
		expect(result.unresolved).toHaveLength(1);
		expect(result.unresolved[0]).toContain("build context");
	});

	it("judges a lone variable with a default as that default", () => {
		expect(check(service("    build: ${CTX:-./app}"))).toEqual(clean);
		expect(
			check(service("    build: ${CTX:-/}")).forbiddenParents,
		).toHaveLength(1);
	});

	it("trusts no variable when the env file is not written (strict)", () => {
		expect(
			check(service("    build: ${SRC}/../x"), { env: null, strict: true })
				.unresolved,
		).toHaveLength(1);
		// A relative path with no variable is still fine.
		expect(
			check(service("    build: ./app"), { env: null, strict: true }),
		).toEqual(clean);
	});

	it("leaves remote contexts alone", () => {
		for (const remote of [
			"https://github.com/acme/app.git#main",
			"http://example.com/context.tar.gz",
			"git://example.com/acme/app.git",
			"ssh://git@example.com/acme/app.git",
			"git@github.com:acme/app.git",
			"github.com/acme/app",
		]) {
			expect(check(service(`    build: ${remote}`))).toEqual(clean);
			expect(
				check(service(`    build:\n      context: ${remote}`)),
			).toEqual(clean);
		}
		expect(
			check(service("    build: ${REPO}"), {
				env: { REPO: "https://github.com/acme/app.git" },
			}),
		).toEqual(clean);
	});

	it("does not take a look-alike for a remote context", () => {
		// Compose only knows the prefixes in lowercase, so this is a directory.
		expect(check(service(`    build: GIT@/${UP}${VICTIM}`)).forbidden).toHaveLength(
			1,
		);
		expect(
			check(service(`    build: ./https://${UP}${VICTIM}`)).forbidden,
		).toHaveLength(1);
	});

	it("keeps legit relative contexts unchanged", () => {
		for (const context of [".", "./", "./app", "app", "../shared", "./a/../b"]) {
			expect(check(service(`    build: ${context}`))).toEqual(clean);
			expect(
				check(service(`    build:\n      context: ${context}`)),
			).toEqual(clean);
		}
		expect(
			check(
				service(
					"    build:\n      context: ./app\n      dockerfile: docker/Dockerfile.prod\n      args:\n        A: b",
				),
			),
		).toEqual(clean);
	});
});

describe("build.dockerfile outside the context", () => {
	it("refuses a dockerfile that climbs out of the context into the storage", () => {
		const yaml = service(
			`    build:\n      context: ./app\n      dockerfile: ${UP}${VICTIM}/Dockerfile`,
		);
		expect(check(yaml).forbidden).toHaveLength(1);
		expect(check(yaml).forbidden[0]).toContain("build dockerfile");
	});

	it("refuses an absolute dockerfile in the storage, also with a remote context", () => {
		const dockerfile = `${VICTIM}/Dockerfile`;
		for (const context of ["./app", "https://github.com/acme/app.git"]) {
			expect(
				check(
					service(
						`    build:\n      context: ${context}\n      dockerfile: ${dockerfile}`,
					),
				).forbidden,
			).toEqual([`build dockerfile "${dockerfile}"`]);
		}
	});

	it("refuses a dockerfile variable that resolves into the storage", () => {
		const yaml = service(
			"    build:\n      context: ./app\n      dockerfile: ${DF}",
		);
		expect(
			check(yaml, { env: { DF: `${VICTIM}/Dockerfile` } }).forbidden,
		).toHaveLength(1);
		expect(
			check(yaml, { env: { DF: `${UP}${VICTIM}/Dockerfile` } }).forbidden
				.length,
		).toBeGreaterThan(0);
	});

	it("refuses a context and dockerfile that only add up to the storage", () => {
		expect(
			check(
				service(
					"    build:\n      context: /var/lib\n      dockerfile: docker/volumes/victim_data/_data/Dockerfile",
				),
			).forbiddenParents,
		).toEqual(['build context "/var/lib"']);
		expect(
			check(
				service(
					"    build:\n      context: ./a\n      dockerfile: ../../../../../../../../../../var/lib/docker/volumes/x/Dockerfile",
				),
			).forbidden,
		).toHaveLength(1);
	});

	it("keeps a dockerfile inside or next to the context", () => {
		for (const dockerfile of [
			"Dockerfile",
			"./docker/Dockerfile",
			"../Dockerfile.shared",
		]) {
			expect(
				check(
					service(
						`    build:\n      context: ./app\n      dockerfile: ${dockerfile}`,
					),
				),
			).toEqual(clean);
		}
	});

	it("does not read the dockerfile of a remote context as a host path", () => {
		for (const dockerfile of ["Dockerfile", "docker/Dockerfile.prod"]) {
			expect(
				check(
					service(
						`    build:\n      context: https://github.com/acme/app.git\n      dockerfile: ${dockerfile}`,
					),
				),
			).toEqual(clean);
		}
	});

	it("reads a dockerfile that climbs out of a remote-looking context", () => {
		// A directory named like a URL in the build tree makes it a local path.
		for (const context of ["https://github.com/acme/app.git", "github.com/a/b"]) {
			expect(
				check(
					service(
						`    build:\n      context: ${context}\n      dockerfile: ${UP}${VICTIM}/Dockerfile`,
					),
				).forbidden.length,
			).toBeGreaterThan(0);
		}
	});

	it("judges the join with a lone default context as that default (strict)", () => {
		// `${CTX:-..}/Dockerfile` is `../Dockerfile`, not a path that climbs from
		// an unknown directory.
		expect(
			check(
				service(
					"    build:\n      context: ${CTX:-..}\n      dockerfile: Dockerfile",
				),
				STRICT,
			),
		).toEqual(clean);
		expect(
			check(
				service(
					"    build:\n      context: ${CTX:-./app}\n      dockerfile: docker/Dockerfile",
				),
				STRICT,
			),
		).toEqual(clean);
		expect(
			check(
				service(
					"    build:\n      context: ${CTX:-/}\n      dockerfile: Dockerfile",
				),
				STRICT,
			).forbiddenParents.length,
		).toBeGreaterThan(0);
		// Any other variable next to a climb is still refused.
		expect(
			check(
				service(
					"    build:\n      context: ${CTX}\n      dockerfile: ../Dockerfile",
				),
				STRICT,
			).unresolved,
		).toHaveLength(1);
	});
});

describe("remote-looking and file:// contexts that climb", () => {
	const shapes = (suffix: string) => [
		`github.com/${suffix}`,
		`https://x/${suffix}`,
		`http://x/${suffix}`,
		`git@x/${suffix}`,
		`git://x/${suffix}`,
		`ssh://x/${suffix}`,
	];
	const climb = `${UP}${VICTIM}`;

	it("refuses a build context, in both forms", () => {
		for (const context of shapes(climb)) {
			expect(
				check(service(`    build: '${context}'`)).forbidden.length,
			).toBeGreaterThan(0);
			expect(
				check(service(`    build:\n      context: '${context}'`)).forbidden
					.length,
			).toBeGreaterThan(0);
		}
		expect(
			check(service(`    build: 'github.com/${UP}'`)).forbiddenParents.length,
		).toBeGreaterThan(0);
	});

	it("refuses an additional context", () => {
		for (const context of shapes(climb)) {
			expect(
				check(
					service(
						`    build:\n      context: .\n      additional_contexts:\n        a: '${context}'`,
					),
				).forbidden.length,
			).toBeGreaterThan(0);
		}
	});

	it("refuses one that a variable turns into such a path", () => {
		expect(
			check(service("    build: ${REPO}"), {
				env: { REPO: `github.com/${climb}` },
			}).forbidden.length,
		).toBeGreaterThan(0);
		expect(
			check(service("    build: https://${HOST}/../../x"), STRICT).unresolved,
		).toHaveLength(1);
	});

	it("keeps real URLs, with and without a fragment, and a harmless climb", () => {
		for (const context of [
			"https://github.com/acme/app.git#main:sub",
			"git@github.com:acme/app.git",
			"https://example.com/a/../b.tar.gz",
		]) {
			expect(check(service(`    build: '${context}'`))).toEqual(clean);
		}
	});

	it("reads file:// as a path", () => {
		expect(
			check(service(`    build: file://${VICTIM}`)).forbidden.length,
		).toBeGreaterThan(0);
		expect(
			check(service("    build: file:///")).forbiddenParents.length,
		).toBeGreaterThan(0);
		expect(
			check(
				service(
					`    build:\n      context: .\n      additional_contexts:\n        a: file://${VICTIM}`,
				),
			).forbidden.length,
		).toBeGreaterThan(0);
		expect(
			check(service("    build: ${CTX}"), {
				env: { CTX: `file://${VICTIM}` },
			}).forbidden.length,
		).toBeGreaterThan(0);
		expect(check(service("    build: file://./app"))).toEqual(clean);
	});
});

describe("oci-layout as the build context", () => {
	it("checks the layout directory of the main context", () => {
		expect(
			check(service(`    build: oci-layout://${VICTIM}:latest`)).forbidden
				.length,
		).toBeGreaterThan(0);
		expect(
			check(
				service(`    build:\n      context: oci-layout://${UP}${VICTIM}`),
			).forbidden.length,
		).toBeGreaterThan(0);
		expect(
			check(service("    build: oci-layout:///")).forbiddenParents.length,
		).toBeGreaterThan(0);
		expect(check(service("    build: oci-layout://./layouts/base:v1"))).toEqual(
			clean,
		);
	});
});

describe("build.additional_contexts", () => {
	it("refuses a path in the map and the list form", () => {
		expect(
			check(
				service(
					`    build:\n      context: .\n      additional_contexts:\n        data: ${VICTIM}`,
				),
			).forbidden,
		).toEqual([`additional build context "${VICTIM}"`]);
		expect(
			check(
				service(
					`    build:\n      context: .\n      additional_contexts:\n        - data=${UP}${VICTIM}\n        - ok=./other`,
				),
			).forbidden,
		).toEqual([`additional build context "${UP}${VICTIM}"`]);
		expect(
			check(
				service(
					"    build:\n      context: .\n      additional_contexts:\n        root: /",
				),
			).forbiddenParents,
		).toHaveLength(1);
	});

	it("reads an oci-layout directory", () => {
		expect(
			check(
				service(
					`    build:\n      context: .\n      additional_contexts:\n        lib: oci-layout://${STORAGE}/victim_data/_data:latest@sha256:abc`,
				),
			).forbidden,
		).toHaveLength(1);
		expect(
			check(
				service(
					"    build:\n      context: .\n      additional_contexts:\n        lib: oci-layout://./layouts/base:latest",
				),
			),
		).toEqual(clean);
	});

	it("leaves service:, docker-image:// and remote values alone", () => {
		expect(
			check(
				service(`    build:
      context: .
      additional_contexts:
        base: service:base
        img: docker-image://alpine:3.20
        repo: https://github.com/acme/lib.git
        local: ./lib`),
			),
		).toEqual(clean);
	});

	it("applies the variable rules", () => {
		const yaml = service(
			"    build:\n      context: .\n      additional_contexts:\n        data: ${DATA}",
		);
		expect(check(yaml, { env: { DATA: VICTIM } }).forbidden).toHaveLength(1);
		expect(check(yaml, { env: { DATA: "service:base" } })).toEqual(clean);
	});
});

describe("build.ssh and the local build cache", () => {
	it("refuses a key file and a cache directory in the storage", () => {
		expect(
			check(
				service(
					`    build:\n      context: .\n      ssh:\n        - default\n        - key=${VICTIM}/id_rsa`,
				),
			).forbidden,
		).toEqual([`build ssh key "${VICTIM}/id_rsa"`]);
		expect(
			check(
				service(
					`    build:\n      context: .\n      ssh:\n        key: ${VICTIM}/id_rsa`,
				),
			).forbidden,
		).toHaveLength(1);
		expect(
			check(
				service(
					`    build:\n      context: .\n      cache_from:\n        - type=local,src=${VICTIM}\n        - acme/app:cache\n      cache_to:\n        - type=local,dest=${VICTIM},mode=max`,
				),
			).forbidden,
		).toHaveLength(2);
	});

	it("checks every comma-separated key path of ssh", () => {
		for (const ssh of [
			`      ssh:\n        - k=./safe,${VICTIM}/id`,
			`      ssh:\n        - k=${VICTIM}/id,./safe`,
			`      ssh:\n        k: ./safe,${VICTIM}/id`,
		]) {
			expect(
				check(service(`    build:\n      context: .\n${ssh}`)).forbidden,
			).toEqual([`build ssh key "${VICTIM}/id"`]);
		}
		expect(
			check(
				service(
					"    build:\n      context: .\n      ssh:\n        - default\n        - agent\n        - k=./a,./b",
				),
			),
		).toEqual(clean);
	});

	it("reads a quoted cache entry the way buildx does", () => {
		const cache = (key: string, entry: string) =>
			service(
				`    build:\n      context: .\n      ${key}:\n        - ${JSON.stringify(entry)}`,
			);
		for (const key of ["cache_from", "cache_to"]) {
			const field = key === "cache_from" ? "src" : "dest";
			for (const entry of [
				`type=local,"${field}=${VICTIM}"`,
				`"type=local",${field}=${VICTIM}`,
				`type=local,"${field}=${VICTIM}",mode=max`,
				`TYPE=LOCAL,${field}=${VICTIM}`,
				` type = local , ${field} = ${VICTIM}`,
				`type=local,${field}="${VICTIM}"`,
				`"${field}"=${VICTIM},"type"="local"`,
				`type=lo"cal",${field}=${VICTIM}`,
			]) {
				expect(
					check(cache(key, entry)).forbidden.length,
					`${key} ${entry}`,
				).toBeGreaterThan(0);
			}
		}
		// A doubled quote inside a quoted field is one quote.
		expect(
			check(cache("cache_to", `type=local,"dest=""${VICTIM}"""`)).forbidden
				.length,
		).toBeGreaterThan(0);
		// A variable in the entry.
		expect(
			check(cache("cache_to", 'type=local,"dest=${D}"'), { env: { D: VICTIM } })
				.forbidden.length,
		).toBeGreaterThan(0);
	});

	it("checks an entry that only mentions local or has a quote, and keeps the rest", () => {
		expect(
			check(
				service(
					`    build:\n      context: .\n      cache_to:\n        - 'ty"pe"=registry,dest=${VICTIM}'\n        - 'x=local,src=${VICTIM}'`,
				),
			).forbidden,
		).toHaveLength(2);
		expect(
			check(
				service(
					'    build:\n      context: .\n      cache_from:\n        - "type=registry,ref=acme/local:cache"\n        - "type=gha"\n        - "type=local,src=./cache,mode=max"',
				),
			),
		).toEqual(clean);
	});

	it("keeps the agent, images and registry or local caches in place", () => {
		expect(
			check(
				service(`    build:
      context: .
      ssh:
        - default
      cache_from:
        - acme/app:cache
        - type=registry,ref=acme/app:cache
        - type=local,src=./.cache
      cache_to:
        - type=inline
        - type=local,dest=./.cache,mode=max`),
			),
		).toEqual(clean);
	});
});

describe("develop.watch", () => {
	const watch = (path: string) =>
		service(
			`    develop:\n      watch:\n        - path: ${path}\n          action: sync\n          target: /x`,
		);

	it("refuses a watch path in the storage or above it", () => {
		expect(check(watch(VICTIM)).forbidden).toEqual([
			`develop watch path "${VICTIM}"`,
		]);
		expect(check(watch(UP)).forbiddenParents).toHaveLength(1);
		expect(check(watch("/var/lib/docker")).forbiddenParents).toHaveLength(1);
	});

	it("applies the variable rules", () => {
		expect(
			check(watch("${SRC}"), { env: { SRC: VICTIM } }).forbidden,
		).toHaveLength(1);
		expect(check(watch("${SRC}/../.."), STRICT).unresolved).toHaveLength(1);
		expect(check(watch("${SRC:-./src}"))).toEqual(clean);
	});

	it("keeps legit watch paths", () => {
		expect(check(watch("./src"))).toEqual(clean);
		expect(check(watch("package.json"))).toEqual(clean);
	});
});

describe("env_file", () => {
	it("refuses the string, list and path forms", () => {
		expect(check(service(`    env_file: ${VICTIM}/.env`)).forbidden).toEqual([
			`env_file "${VICTIM}/.env"`,
		]);
		expect(
			check(
				service(`    env_file:\n      - ./ok.env\n      - ${UP}${VICTIM}/.env`),
			).forbidden,
		).toEqual([`env_file "${UP}${VICTIM}/.env"`]);
		expect(
			check(
				service(
					`    env_file:\n      - path: ./ok.env\n      - path: ${VICTIM}/.env\n        required: false`,
				),
			).forbidden,
		).toEqual([`env_file "${VICTIM}/.env"`]);
		expect(check(service("    env_file: /")).forbiddenParents).toHaveLength(1);
	});

	it("also covers label_file", () => {
		expect(
			check(service(`    label_file: ${VICTIM}/labels`)).forbidden,
		).toHaveLength(1);
	});

	it("applies the variable rules", () => {
		expect(
			check(service("    env_file: ${ENV_DIR}/app.env"), {
				env: { ENV_DIR: VICTIM },
			}).forbidden,
		).toHaveLength(1);
		expect(
			check(service("    env_file:\n      - path: ${X}/../../a.env"), STRICT)
				.unresolved,
		).toHaveLength(1);
		expect(check(service("    env_file: ${ENV_FILE:-./.env}"))).toEqual(clean);
	});

	it("keeps legit env files", () => {
		for (const body of [
			"    env_file: .env",
			"    env_file: ./config/app.env",
			"    env_file:\n      - ../shared.env\n      - path: ./local.env\n        required: false",
		]) {
			expect(check(service(body))).toEqual(clean);
		}
	});
});

describe("secrets and configs files", () => {
	const top = (section: string, file: string) => `
services:
  web:
    image: nginx
${section}:
  token:
    file: ${file}
`;

	it("refuses a file in the storage or above it", () => {
		expect(check(top("secrets", `${VICTIM}/token`)).forbidden).toEqual([
			`secret file of "token" "${VICTIM}/token"`,
		]);
		expect(
			check(top("configs", `${UP}${VICTIM}/app.conf`)).forbidden,
		).toEqual([`config file of "token" "${UP}${VICTIM}/app.conf"`]);
		expect(check(top("secrets", "/")).forbiddenParents).toHaveLength(1);
		expect(
			check(top("configs", "/var/lib/docker")).forbiddenParents,
		).toHaveLength(1);
	});

	it("applies the variable rules", () => {
		expect(
			check(top("secrets", "${SECRETS}/token"), {
				env: { SECRETS: VICTIM },
			}).forbidden,
		).toHaveLength(1);
		expect(
			check(top("configs", "${CONF_DIR}/../../x"), STRICT).unresolved,
		).toHaveLength(1);
		expect(check(top("secrets", "${TOKEN_FILE:-./token}"))).toEqual(clean);
	});

	it("keeps legit files, environment and external secrets", () => {
		expect(check(top("secrets", "./secrets/token"))).toEqual(clean);
		expect(check(top("configs", "../conf/app.conf"))).toEqual(clean);
		expect(
			check(`
services:
  web:
    image: nginx
secrets:
  a:
    environment: TOKEN
  b:
    external: true
configs:
  c:
    content: hello
`),
		).toEqual(clean);
	});

	it("checks every file that declares one", () => {
		const { forbidden } = resolveComposeFilesMountedVolumes(
			[
				parse(top("secrets", "./ok")),
				parse(top("secrets", `${VICTIM}/token`)),
			],
			{ appName: APP, env: {}, baseDirs: [BASE] },
		);
		expect(forbidden).toHaveLength(1);
	});
});

describe("volumes are unaffected", () => {
	it("keeps judging the volumes as before, next to the new paths", () => {
		const result = check(
			service(
				`    build: .\n    env_file: .env\n    volumes:\n      - ${VICTIM}:/x\n      - /var/lib:/y`,
			),
		);
		expect(result.forbidden).toEqual([`bind mount "${VICTIM}"`]);
		expect(result.forbiddenParents).toEqual(['bind mount "/var/lib"']);
	});
});

describe("assertComposeVolumesBound", () => {
	const deploy = (file: string, row = {}) =>
		assertComposeVolumesBound(composeRow(file, row));

	it("refuses each key at deploy, before anything is built", async () => {
		for (const body of [
			`    build: ${VICTIM}`,
			`    build:\n      context: .\n      dockerfile: ${VICTIM}/Dockerfile`,
			`    build:\n      context: .\n      additional_contexts:\n        a: ${VICTIM}`,
			`    env_file: ${VICTIM}/.env`,
			`    env_file:\n      - path: ${VICTIM}/.env`,
			`    develop:\n      watch:\n        - path: ${VICTIM}\n          action: sync\n          target: /x`,
		]) {
			await expect(deploy(service(body))).rejects.toThrow(
				/Compose volume refused: .* is Docker's own volume storage/,
			);
		}
		await expect(
			deploy(`${service("")}\nsecrets:\n  t:\n    file: ${VICTIM}\n`),
		).rejects.toThrow(/Compose volume refused: secret file of "t"/);
		await expect(
			deploy(`${service("")}\nconfigs:\n  t:\n    file: /var/lib/docker\n`),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it("resolves relative paths from the compose directory", async () => {
		await expect(deploy(service(`    build: ${UP}${VICTIM}`))).rejects.toThrow(
			/Docker's own volume storage/,
		);
		await expect(deploy(service("    build: ./app"))).resolves.toBeUndefined();
	});

	it("resolves variables from the Environment tab", async () => {
		await expect(
			deploy(service("    env_file: ${DIR}/.env"), { env: `DIR=${VICTIM}` }),
		).rejects.toThrow(/Docker's own volume storage/);
		await expect(
			deploy(service("    env_file: ${DIR}/.env"), { env: "DIR=./cfg" }),
		).resolves.toBeUndefined();
	});

	it("refuses a path it cannot resolve when Create env file is off", async () => {
		await expect(
			deploy(service("    env_file: ${DIR}/../../.env"), {
				createEnvFile: false,
			}),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("lets a compose with legit contexts, env files and secrets deploy", async () => {
		await expect(
			deploy(`
services:
  web:
    build:
      context: ./app
      dockerfile: Dockerfile
      additional_contexts:
        base: service:base
        img: docker-image://alpine:3.20
    env_file:
      - .env
      - path: ./local.env
        required: false
    develop:
      watch:
        - path: ./app/src
          action: sync
          target: /app/src
    secrets:
      - token
    configs:
      - conf
  base:
    build: https://github.com/acme/base.git
secrets:
  token:
    file: ./secrets/token
configs:
  conf:
    file: ./conf/app.conf
`),
		).resolves.toBeUndefined();
	});

	it("is checked on save for a raw compose too", async () => {
		await expect(
			assertComposeFileVolumesBound(
				composeRow("") as never,
				service(`    build: ${VICTIM}`),
			),
		).rejects.toThrow(/Docker's own volume storage/);
		await expect(
			assertComposeFileVolumesBound(
				composeRow("") as never,
				service("    build: ./app"),
			),
		).resolves.toBeUndefined();
	});
});
