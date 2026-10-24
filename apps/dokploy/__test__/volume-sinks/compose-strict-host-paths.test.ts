import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7160: with "Create env file" off, Compose reads the `.env` of the project
// directory, which a repository brings. A host path that depends on a variable
// is judged with the value that file gives it (and refused when it cannot be
// read), for a bind source and for every key T-7142 checks.
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
		readDotenv: vi.fn(),
		execAsyncRemote: vi.fn(),
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

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	open: async (path: string) => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		const result = await mocks.readDotenv(path);
		return typeof result === "string" ? dotenvHandle(result) : result;
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { assertComposeVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const { paths } = await import("@dokploy/server/constants");
const { parseDotenvVariables, UNRESOLVED_VARIABLE_VALUE } = await import(
	"@dokploy/server/utils/volume-backups/compose-volumes"
);

const APP = "compose-x-AbC123";
const STORAGE = "/var/lib/docker/volumes";
const VICTIM = `${STORAGE}/victim_data/_data`;
const CODE = `${paths(false)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;
const REMOTE_CODE = `${paths(true)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;

const fsError = (code: string) => Object.assign(new Error(code), { code });

// The `.env` files that are on the host, by directory.
const dotenvFiles = (files: Record<string, string>) =>
	mocks.readDotenv.mockImplementation(async (path: string) => {
		const content = files[path];
		if (content === undefined) {
			throw fsError("ENOENT");
		}
		return content;
	});

const composeRow = (composeFile: string, overrides = {}) =>
	({
		composeId: "compose-1",
		appName: APP,
		sourceType: "raw",
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile,
		command: "",
		createEnvFile: false,
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
	mocks.readDotenv.mockRejectedValue(fsError("ENOENT"));
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
});

const service = (body: string) => `
services:
  web:
    image: nginx
${body}
`;

// Every key that Compose reads from the host, with `${V}` as the path.
const KEYS: Array<[string, (value: string) => string]> = [
	["volumes (short)", (v) => service(`    volumes:\n      - "${v}:/data"`)],
	[
		"volumes (long bind)",
		(v) =>
			service(
				`    volumes:\n      - type: bind\n        source: "${v}"\n        target: /data`,
			),
	],
	["build (string)", (v) => service(`    build: "${v}"`)],
	["build.context", (v) => service(`    build:\n      context: "${v}"`)],
	[
		"build.additional_contexts",
		(v) =>
			service(
				`    build:\n      context: ./app\n      additional_contexts:\n        extra: "${v}"`,
			),
	],
	["env_file (string)", (v) => service(`    env_file: "${v}"`)],
	["env_file (list)", (v) => service(`    env_file:\n      - "${v}"`)],
	[
		"env_file (path:)",
		(v) =>
			service(`    env_file:\n      - path: "${v}"\n        required: false`),
	],
	["label_file", (v) => service(`    label_file: "${v}"`)],
	[
		"develop.watch",
		(v) =>
			service(
				`    develop:\n      watch:\n        - path: "${v}"\n          action: sync\n          target: /app`,
			),
	],
	[
		"secrets",
		(v) =>
			`${service("    secrets:\n      - s")}\nsecrets:\n  s:\n    file: "${v}"\n`,
	],
	[
		"configs",
		(v) =>
			`${service("    configs:\n      - c")}\nconfigs:\n  c:\n    file: "${v}"\n`,
	],
];

const refusedByStorage = /is Docker's own volume storage/;
const failed = /Compose volume check failed/;

describe("parseDotenvVariables", () => {
	it("reads plain, exported, quoted and commented lines", () => {
		expect(
			parseDotenvVariables(
				[
					"# a comment",
					"",
					"A=one",
					"export B=two",
					"C = three  # trailing",
					'D="four five"',
					"E='six $A'",
					"F=a#b",
					"G=",
				].join("\n"),
			),
		).toEqual({
			A: "one",
			B: "two",
			C: "three",
			D: "four five",
			E: "six $$A",
			F: "a#b",
			G: "",
		});
	});

	it("reads CRLF files and a byte order mark", () => {
		expect(parseDotenvVariables("\uFEFFA=1\r\nB=2\r\n")).toEqual({
			A: "1",
			B: "2",
		});
	});

	it("reads a quoted value over several lines", () => {
		expect(parseDotenvVariables('KEY="line one\nline two"\nB=2')).toEqual({
			KEY: "line one\nline two",
			B: "2",
		});
		expect(parseDotenvVariables("KEY='a\nb'\nB=2")).toEqual({
			KEY: "a\nb",
			B: "2",
		});
	});

	it("does not understand what it cannot be sure of", () => {
		for (const text of [
			"not an assignment",
			"A=1\nA=2",
			'A="never closed',
			"A='never closed",
			"A=`tick`",
			'A="x" y',
			"A=1\rB=2",
			"COMPOSE_ENV_FILES=/etc/other.env",
		]) {
			expect(parseDotenvVariables(text)).toBeNull();
		}
	});

	it("marks a value whose escape or comment is not certain", () => {
		expect(parseDotenvVariables('A="x\\dy"\nB="x\\$y"\nC=#hash')).toEqual({
			A: UNRESOLVED_VARIABLE_VALUE,
			B: UNRESOLVED_VARIABLE_VALUE,
			C: UNRESOLVED_VARIABLE_VALUE,
		});
		expect(parseDotenvVariables('A="a\\nb\\"c\\\\"')).toEqual({
			A: 'a\nb"c\\',
		});
	});

	it("keeps names that cannot be referenced out", () => {
		expect(parseDotenvVariables("my.key=1\nA=2")).toEqual({ A: "2" });
	});
});

describe("a committed .env with Create env file off", () => {
	describe.each(KEYS)("%s", (_name, build) => {
		it("is refused when the .env points the variable at Docker's volume storage", async () => {
			dotenvFiles({ [`${CODE}/.env`]: `DIR=${VICTIM}\n` });
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR}"))),
			).rejects.toThrow(refusedByStorage);
		});

		it("is refused for the plain $VAR form and a path built from the variable", async () => {
			dotenvFiles({ [`${CODE}/.env`]: `DIR=${STORAGE}\n` });
			await expect(
				assertComposeVolumesBound(composeRow(build("$DIR/victim_data/_data"))),
			).rejects.toThrow(refusedByStorage);
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR}/victim_data"))),
			).rejects.toThrow(refusedByStorage);
		});

		it("is refused when a value holds a $ and a .., which keeps it from resolving", async () => {
			// '<victim>/$x/..' is the victim's directory once Docker creates $x.
			dotenvFiles({ [`${CODE}/.env`]: `DIR='${VICTIM}/$x/..'\n` });
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR}"))),
			).rejects.toThrow(failed);
		});

		it("passes when the .env gives a safe path", async () => {
			dotenvFiles({ [`${CODE}/.env`]: "DIR=./data\nF=./data/file\n" });
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR}"))),
			).resolves.toBeUndefined();
		});

		it("passes with a literal default, and the .env beats the default", async () => {
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR:-./ok}"))),
			).resolves.toBeUndefined();
			dotenvFiles({ [`${CODE}/.env`]: `DIR=${VICTIM}\n` });
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR:-./ok}"))),
			).rejects.toThrow(refusedByStorage);
		});

		it("is refused when the .env cannot be read, default or not", async () => {
			mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
			for (const value of ["${DIR}", "$DIR", "${DIR:-./ok}", "./${DIR}"]) {
				await expect(
					assertComposeVolumesBound(composeRow(build(value))),
				).rejects.toThrow(failed);
			}
			// No variable, nothing to read.
			await expect(
				assertComposeVolumesBound(composeRow(build("./ok"))),
			).resolves.toBeUndefined();
		});

		it("is refused when the .env is not understood", async () => {
			dotenvFiles({ [`${CODE}/.env`]: "this is not a dotenv line\n" });
			await expect(
				assertComposeVolumesBound(composeRow(build("${DIR}"))),
			).rejects.toThrow(failed);
		});

		it("is judged with the Environment tab values when Create env file is on", async () => {
			// Dokploy writes the .env and passes it with --env-file: the committed
			// file is not read at all.
			dotenvFiles({ [`${CODE}/.env`]: "DIR=./committed\n" });
			await expect(
				assertComposeVolumesBound(
					composeRow(build("${DIR}"), {
						createEnvFile: true,
						env: `DIR=${VICTIM}`,
					}),
				),
			).rejects.toThrow(refusedByStorage);
			await expect(
				assertComposeVolumesBound(
					composeRow(build("${DIR}"), {
						createEnvFile: true,
						env: "DIR=./safe",
					}),
				),
			).resolves.toBeUndefined();
			expect(mocks.readDotenv).not.toHaveBeenCalled();
		});
	});

	it("refuses a bare variable nobody defines only when the .env could not be read", async () => {
		// Not defined in a .env that was read: Compose uses an empty string.
		dotenvFiles({ [`${CODE}/.env`]: "OTHER=1\n" });
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${X}/app"))),
		).resolves.toBeUndefined();
		mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${X}/app"))),
		).rejects.toThrow(failed);
	});

	it("expands the references between the values like Compose does", async () => {
		dotenvFiles({
			[`${CODE}/.env`]: [
				`ROOT=${STORAGE}`,
				"MID=${ROOT}/victim_data",
				'DIR="${MID}/_data"',
			].join("\n"),
		});
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${DIR}"))),
		).rejects.toThrow(refusedByStorage);
		// A reference to a later line is not followed: nothing is trusted for it.
		dotenvFiles({
			[`${CODE}/.env`]: ["DIR=${LATER}/x", `LATER=${STORAGE}`].join("\n"),
		});
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${DIR}"))),
		).rejects.toThrow(failed);
	});

	it("takes a single-quoted value literally and $$ as a dollar sign", async () => {
		dotenvFiles({ [`${CODE}/.env`]: "A='$HOME/data'\nB=x$$y\n" });
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${A}"))),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ./${B}"))),
		).resolves.toBeUndefined();
	});

	it("does not let the .env set PATH or HOME, which the process owns", async () => {
		dotenvFiles({ [`${CODE}/.env`]: `HOME=${VICTIM}\nPATH=${VICTIM}\n` });
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${HOME}"))),
		).resolves.toBeUndefined();
	});

	it("reads the .env on the compose's server for a remote compose", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: `DIR=${VICTIM}\n`,
			stderr: "",
		});
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}"), { serverId: "server-1" }),
			),
		).rejects.toThrow(refusedByStorage);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("server-1");
		expect(command).toContain(`${REMOTE_CODE}/.env`);
		expect(mocks.readDotenv).not.toHaveBeenCalled();

		// A file that is not there is empty, and an ssh failure is not known.
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}/app"), {
					serverId: "server-1",
				}),
			),
		).resolves.toBeUndefined();
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh failed"));
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}/app"), {
					serverId: "server-1",
				}),
			),
		).rejects.toThrow(failed);
	});

	it("does not trust a .env that is larger than a megabyte", async () => {
		dotenvFiles({ [`${CODE}/.env`]: `A=${"x".repeat(1024 * 1024 + 1)}\n` });
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${DIR}/app"))),
		).rejects.toThrow(failed);
	});

	it("does not read a .env for a stack, which only sees the shell", async () => {
		dotenvFiles({ [`${CODE}/.env`]: `DIR=${VICTIM}\n` });
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    volumes:\n      - ${DIR}:/data"), {
					composeType: "stack",
					env: "DIR=./safe",
				}),
			),
		).resolves.toBeUndefined();
		expect(mocks.readDotenv).not.toHaveBeenCalled();
	});
});

describe("a custom command", () => {
	const command = (flags: string) =>
		`compose -p ${APP} ${flags} -f ${CODE}/docker-compose.yml up -d`;

	it("reads the .env of the --project-directory, also with Create env file on", async () => {
		const row = (overrides = {}) =>
			composeRow(service("    build: ${DIR}"), {
				createEnvFile: true,
				env: "DIR=./safe",
				command: command(`--project-directory ${CODE}/sub`),
				...overrides,
			});
		dotenvFiles({ [`${CODE}/sub/.env`]: `DIR=${VICTIM}\n` });
		await expect(assertComposeVolumesBound(row())).rejects.toThrow(
			refusedByStorage,
		);
		// Compose may read either directory, so a victim path in either is refused.
		dotenvFiles({ [`${CODE}/sub/.env`]: "DIR=./sub\n" });
		await expect(assertComposeVolumesBound(row())).resolves.toBeUndefined();
		dotenvFiles({
			[`${CODE}/sub/.env`]: "DIR=./sub\n",
			[`${CODE}/.env`]: `DIR=${VICTIM}\n`,
		});
		await expect(
			assertComposeVolumesBound(row({ createEnvFile: false })),
		).rejects.toThrow(refusedByStorage);
	});

	it("uses the written env for the directory Dokploy writes it in", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}"), {
					createEnvFile: true,
					env: `DIR=${VICTIM}`,
					command: command(""),
				}),
			),
		).rejects.toThrow(refusedByStorage);
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}"), {
					createEnvFile: true,
					env: "DIR=./safe",
					command: command(""),
				}),
			),
		).resolves.toBeUndefined();
	});

	it("trusts no variable of a host path when it brings its own --env-file", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR:-./ok}"), {
					createEnvFile: true,
					command: command("--env-file evil.env"),
				}),
			),
		).rejects.toThrow(failed);
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ./ok"), {
					createEnvFile: true,
					command: command("--env-file evil.env"),
				}),
			),
		).resolves.toBeUndefined();
	});
});

// N1: a `..` followed by `}` is a climb too.
describe("a remote-looking context that climbs through defaults", () => {
	const N1 =
		"github.com/${A:-..}${B:-/..}${C:-/..}${D:-/..}${E:-/..}${F:-/..}${G:-/..}${H:-/..}${I:-/var/lib/docker/volumes/v}";
	const build = (value: string) => service(`    build: "${value}"`);

	it("is refused when the .env cannot be read", async () => {
		mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
		await expect(
			assertComposeVolumesBound(composeRow(build(N1))),
		).rejects.toThrow(failed);
	});

	it("is refused when the defaults are used", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(build(N1))),
		).rejects.toThrow(refusedByStorage);
	});

	it("is refused in the dockerfile of a remote context too", async () => {
		const compose = service(
			`    build:\n      context: https://example.com/repo.git\n      dockerfile: "\${A:-..}\${B:-/..}\${C:-/..}\${D:-/..}\${E:-/..}\${F:-/..}\${G:-/..}\${H:-/..}\${I:-/var/lib/docker/volumes/v}/Dockerfile"`,
		);
		await expect(
			assertComposeVolumesBound(composeRow(compose)),
		).rejects.toThrow(refusedByStorage);
		mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
		await expect(
			assertComposeVolumesBound(composeRow(compose)),
		).rejects.toThrow(failed);
	});

	it("still lets a remote context with a variable through when the .env is read", async () => {
		dotenvFiles({ [`${CODE}/.env`]: "ORG=acme\n" });
		await expect(
			assertComposeVolumesBound(
				composeRow(build("https://github.com/${ORG}/app.git#main")),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(build("github.com/${ORG:-acme}/app")),
			),
		).resolves.toBeUndefined();
	});

	it("takes the climb a .env brings into a remote-looking context", async () => {
		dotenvFiles({
			[`${CODE}/.env`]: `UP=../../../../../../../../../..\nV=${VICTIM}\n`,
		});
		await expect(
			assertComposeVolumesBound(composeRow(build("github.com/${UP}${V}"))),
		).rejects.toThrow(refusedByStorage);
	});
});

// Review of T-7160: which environment each docker command of a deploy sees.
describe("the environment each command of a deploy sees", () => {
	const stackCommand = (words: string) => words;

	it("reads the .env for a stack whose custom command runs docker compose", async () => {
		dotenvFiles({ [`${CODE}/.env`]: `DIR=${VICTIM}\n` });
		const row = (overrides = {}) =>
			composeRow(service("    volumes:\n      - ${DIR}:/data"), {
				composeType: "stack",
				createEnvFile: false,
				command: `compose -p ${APP} -f ${CODE}/docker-compose.yml up -d`,
				...overrides,
			});
		await expect(assertComposeVolumesBound(row())).rejects.toThrow(
			refusedByStorage,
		);
		// The staged stack variables are the process environment, which wins
		// over the .env for a variable of both.
		await expect(
			assertComposeVolumesBound(row({ env: "DIR=./safe" })),
		).resolves.toBeUndefined();
	});

	it("checks a stack deploy with the staged env and with nothing", async () => {
		dotenvFiles({ [`${CODE}/.env`]: "DIR=/srv/ok\n" });
		const command = stackCommand(
			`stack deploy -c ${CODE}/docker-compose.yml ${APP}`,
		);
		for (const composeType of ["stack", "docker-compose"]) {
			await expect(
				assertComposeVolumesBound(
					composeRow(
						service(`    volumes:\n      - "\${DIR:-${VICTIM}}:/data"`),
						{ composeType, createEnvFile: false, command, env: "DIR=./safe" },
					),
				),
			).rejects.toThrow(refusedByStorage);
			await expect(
				assertComposeVolumesBound(
					composeRow(service("    volumes:\n      - ${DIR:-./ok}:/data"), {
						composeType,
						createEnvFile: false,
						command,
						env: "DIR=./safe",
					}),
				),
			).resolves.toBeUndefined();
		}
	});
});

describe("reading the .env", () => {
	const hostile = (text: string) => ({ [`${CODE}/.env`]: text });
	const bytesOver = "é".repeat(600_000);

	it("parses a pathological file in well under a second", () => {
		const started = performance.now();
		for (const text of [
			`V="${"\n".repeat(300_000)}`,
			`V="${"a\n".repeat(150_000)}`,
			`V=x${" ".repeat(300_000)}y`,
			`V=x${" ".repeat(300_000)}`,
			`${" ".repeat(300_000)}x`,
			`V='${"\n".repeat(300_000)}`,
			`${"A=1\n".repeat(50_000)}`.replace(/A=1\n/g, (_, i) => `K${i}=1\n`),
		]) {
			parseDotenvVariables(text);
		}
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("does not read a quoted value over many lines", () => {
		expect(parseDotenvVariables(`V="${"\n".repeat(201)}"`)).toBeNull();
		expect(parseDotenvVariables(`V="${"\n".repeat(20)}"`)).toEqual({
			V: "\n".repeat(20),
		});
	});

	it("starts a comment at a space and a hash only", () => {
		expect(parseDotenvVariables("A=/a # c\nB=/b #c\nC=/c#d")).toEqual({
			A: "/a",
			B: "/b",
			C: "/c#d",
		});
		expect(parseDotenvVariables("A=/a\t# c")).toEqual({
			A: UNRESOLVED_VARIABLE_VALUE,
		});
	});

	it("measures the size in bytes, not in characters", async () => {
		// 600k characters, 1.2 MB: a victim path after it must not be dropped.
		const text = `# ${bytesOver}\nDIR=${VICTIM}\n`;
		expect(text.length).toBeLessThan(1024 * 1024);
		dotenvFiles(hostile(text));
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${DIR}"))),
		).rejects.toThrow(failed);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: text, stderr: "" });
		await expect(
			assertComposeVolumesBound(
				composeRow(service("    build: ${DIR}"), { serverId: "server-1" }),
			),
		).rejects.toThrow(failed);
	});

	it("does not read what is not a regular file, or is large", async () => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		for (const handle of [
			dotenvHandle("DIR=./ok\n", { kind: "fifo" }),
			dotenvHandle("DIR=./ok\n", { size: 1024 * 1024 + 1 }),
		]) {
			mocks.readDotenv.mockResolvedValue(handle);
			await expect(
				assertComposeVolumesBound(composeRow(service("    build: ${DIR}"))),
			).rejects.toThrow(failed);
		}
	});

	it("reads a remote file only when it is a regular file, under a time limit", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "DIR=./ok\n",
			stderr: "",
		});
		await assertComposeVolumesBound(
			composeRow(service("    build: ${DIR}"), { serverId: "server-1" }),
		);
		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		expect(command).toContain(`[ -f ${REMOTE_CODE}/.env ]`);
		expect(command).toContain("timeout 10 head -c");
		// Present but not a regular file: the command exits non-zero.
		expect(command).toMatch(/elif \[ -e [^\]]+\]; then exit 3; fi$/);
	});
});

describe("a refusal does not show a value that came from a variable", () => {
	it("shows the compose's text for a volume name", async () => {
		const orgOf = (organizationId: string) => ({
			environment: { project: { organizationId } },
		});
		mocks.query.compose.findFirst.mockResolvedValue({
			appName: APP,
			serverId: null,
			composeFile: "",
			...orgOf("org-a"),
		});
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-b",
				mariadbId: "m-b",
				mariadb: { appName: "m-b", serverId: null, ...orgOf("org-b") },
			},
		]);
		dotenvFiles({ [`${CODE}/.env`]: "NAME=sekret-volume\n" });
		const compose = `
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: \${NAME}
`;
		const error = await assertComposeVolumesBound(composeRow(compose)).catch(
			(caught) => caught as Error,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('Compose volume "${NAME}" is refused');
		expect((error as Error).message).not.toContain("sekret");
	});
});

// Review of T-7160, round 2.
describe("white space that Go knows and JavaScript does not", () => {
	const volumes = service("    volumes:\n      - ${DIR}:/data");

	it("does not read a .env with a NEL, and refuses the path", async () => {
		for (const text of [
			`DIR=\u0085${VICTIM}\n`,
			"DIR=/var/lib/docker\u0085\n",
			`DIR=${VICTIM}\u0085\n`,
		]) {
			dotenvFiles({ [`${CODE}/.env`]: text });
			await expect(
				assertComposeVolumesBound(composeRow(volumes)),
			).rejects.toThrow(failed);
		}
	});

	it("does not read a file with another control or space character", () => {
		for (const character of [
			"\u0000",
			"\u000B",
			"\u007F",
			"\u0080",
			"\u0085",
			"\u009F",
			"\u00A0",
			"\u1680",
			"\u2000",
			"\u200A",
			"\u2028",
			"\u2029",
			"\u202F",
			"\u205F",
			"\u3000",
		]) {
			expect(parseDotenvVariables(`A=x${character}y\n`)).toBeNull();
			expect(parseDotenvVariables(`A=${character}y\n`)).toBeNull();
			expect(parseDotenvVariables(`A=y${character}\n`)).toBeNull();
		}
		// Letters outside ASCII, a tab and a CRLF are read.
		expect(parseDotenvVariables("A=café\tx\r\nB=日本\n")).toEqual({
			A: "café\tx",
			B: "日本",
		});
	});
});

describe("a read that returns less than the file", () => {
	it("is read to the end", async () => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		mocks.readDotenv.mockResolvedValue(
			dotenvHandle(`DIR=${VICTIM}\n`, { chunk: 7 }),
		);
		await expect(
			assertComposeVolumesBound(composeRow(service("    build: ${DIR}"))),
		).rejects.toThrow(refusedByStorage);
	});
});

describe("a stack with chained commands", () => {
	const row = (command: string) =>
		composeRow(service("    volumes:\n      - ${DIR}:/data"), {
			composeType: "stack",
			createEnvFile: false,
			env: "DIR=/srv/tenant/data",
			command,
		});
	const file = `-f ${CODE}/docker-compose.yml`;

	it("also checks the .env alone when more than one command runs", async () => {
		dotenvFiles({ [`${CODE}/.env`]: `DIR=${VICTIM}\n` });
		await expect(
			assertComposeVolumesBound(
				row(
					`compose -p ${APP} ${file} config && docker compose -p ${APP} ${file} up -d`,
				),
			),
		).rejects.toThrow(refusedByStorage);
		// One command: the staged variable wins over the .env.
		await expect(
			assertComposeVolumesBound(row(`compose -p ${APP} ${file} up -d`)),
		).resolves.toBeUndefined();
	});
});
