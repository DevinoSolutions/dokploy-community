import { randomizeDeployableSpecificationFile } from "@dokploy/server/utils/docker/collision";
import {
	interpolateComposeValue,
	resolveComposeMountedVolumes,
} from "@dokploy/server/utils/volume-backups/compose-volumes";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The names a compose file really mounts (T-6822). Pure: the decision whether
// a name is allowed is in compose-volume-sink.test.ts.
const APP = "compose-x-AbC123";

const resolve = (
	yaml: string,
	options: { env?: Record<string, string> | null; strict?: boolean } = {},
) =>
	resolveComposeMountedVolumes(parse(yaml), {
		appName: APP,
		env: options.env === undefined ? {} : options.env,
		strict: options.strict,
	});

const names = (yaml: string, options?: Parameters<typeof resolve>[1]) =>
	resolve(yaml, options).uses.map((use) => use.volumeName);

describe("compose volume names", () => {
	it("prefixes a plain top-level volume with the compose appName", () => {
		const { uses } = resolve(`
services:
  web:
    image: nginx
    volumes:
      - data:/data
volumes:
  data:
`);
		expect(uses).toEqual([
			{ key: "data", volumeName: `${APP}_data`, derived: true },
			{ key: "data", volumeName: `${APP.toLowerCase()}_data`, derived: true },
		]);
	});

	it("uses the key as is for external: true", () => {
		expect(
			names(`
services:
  web:
    volumes:
      - shared:/data
volumes:
  shared:
    external: true
`),
		).toEqual(["shared"]);
	});

	it("uses name: for an external volume, in both spellings", () => {
		expect(
			names(`
services:
  web:
    volumes:
      - a:/a
      - b:/b
volumes:
  a:
    external: true
    name: foreign-a
  b:
    external:
      name: foreign-b
`),
		).toEqual(["foreign-a", "foreign-b"]);
	});

	it("uses name: as is even without external", () => {
		const { uses } = resolve(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: someone-elses-data
`);
		expect(uses).toEqual([
			{ key: "data", volumeName: "someone-elses-data", derived: false },
		]);
	});

	it("reads the long syntax", () => {
		expect(
			names(`
services:
  web:
    volumes:
      - type: volume
        source: shared
        target: /data
      - type: bind
        source: shared
        target: /host
      - type: tmpfs
        target: /tmp
volumes:
  shared:
    external: true
`),
		).toEqual(["shared"]);
	});

	it("ignores bind mounts, anonymous volumes and undeclared keys", () => {
		expect(
			names(`
services:
  web:
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - ~/x:/x
      - /anonymous
      - undeclared:/y
`),
		).toEqual([]);
	});

	it("handles the :ro / :z suffixes", () => {
		expect(
			names(`
services:
  web:
    volumes:
      - shared:/data:ro
volumes:
  shared:
    external: true
`),
		).toEqual(["shared"]);
	});

	it("resolves ${VAR} from the variables Dokploy writes", () => {
		const yaml = `
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: \${TARGET:-fallback}
`;
		expect(names(yaml, { env: { TARGET: "othervol" } })).toEqual(["othervol"]);
		expect(names(yaml, { env: {} })).toEqual(["fallback"]);
	});

	it("reports a name it cannot resolve instead of guessing", () => {
		const yaml = `
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: \${TARGET}
`;
		expect(resolve(yaml, { env: null }).unresolved).toEqual(['volume "data"']);
		expect(resolve(yaml, { env: {}, strict: true }).unresolved).toEqual([
			'volume "data"',
		]);
	});

	it("treats a source that stays unresolved as any declared volume", () => {
		const { uses, unresolved } = resolve(
			`
services:
  web:
    volumes:
      - \${WHICH:?set WHICH}:/data
volumes:
  foreign:
    external: true
`,
			{ env: {} },
		);
		expect(unresolved).toEqual([]);
		expect(uses.map((use) => use.volumeName)).toEqual(["foreign"]);
	});

	it("does not refuse a variable bind mount when no volume is declared", () => {
		const { uses, unresolved } = resolve(
			`
services:
  web:
    volumes:
      - \${DATA_DIR:?set DATA_DIR}:/data
`,
			{ env: {} },
		);
		expect(uses).toEqual([]);
		expect(unresolved).toEqual([]);
	});

	it("refuses a variable source when the env file cannot be read (strict)", () => {
		// It can be a path of the host: a variable of a .env nobody read is any
		// directory (T-7160).
		for (const source of ["${DATA_DIR}", "${DATA_DIR:-./data}", "./${X}"]) {
			const { unresolved } = resolve(
				`
services:
  web:
    volumes:
      - ${source}:/data
`,
				{ env: {}, strict: true },
			);
			expect(unresolved).toHaveLength(1);
		}
		// The source of a long-syntax `type: volume` is a name, not a path.
		const { unresolved } = resolve(
			`
services:
  web:
    volumes:
      - type: volume
        source: \${NAME}
        target: /data
`,
			{ env: {}, strict: true },
		);
		expect(unresolved).toEqual([]);
	});

	it("cannot check include, extends from a file or volumes_from a container", () => {
		expect(
			resolve(`
include:
  - other.yml
services:
  web:
    image: x
`).unresolved,
		).toHaveLength(1);
		expect(
			resolve(`
services:
  web:
    extends:
      file: other.yml
      service: web
`).unresolved,
		).toHaveLength(1);
		expect(
			resolve(`
services:
  web:
    volumes_from:
      - container:db-1
      - cache
`).unresolved,
		).toEqual(['service "web" (volumes_from a container)']);
	});

	it("resolves the final isolated deployment file, not the typed one", () => {
		const spec = parse(`
services:
  web:
    volumes:
      - data:/data
      - shared:/shared
      - foreign:/foreign
volumes:
  data:
  shared:
    external: true
  foreign:
    name: someone-elses-data
`);
		const isolated = randomizeDeployableSpecificationFile(spec, true, APP);
		const { uses } = resolveComposeMountedVolumes(isolated, {
			appName: APP,
			env: {},
		});
		const resolved = uses.map((use) => use.volumeName);
		expect(resolved).toContain(`${APP}_data-${APP}`);
		// An external key is renamed with the suffix, so it is no longer the typed one.
		expect(resolved).toContain(`shared-${APP}`);
		expect(resolved).not.toContain("shared");
		// An explicit name is not touched by the suffix.
		expect(resolved).toContain("someone-elses-data");
	});
});

describe("compose interpolation", () => {
	const env = { SET: "value", EMPTY: "" };
	const cases: Array<[string, string | null]> = [
		["plain", "plain"],
		["$SET", "value"],
		["${SET}", "value"],
		["${MISSING:-d}", "d"],
		["${EMPTY:-d}", "d"],
		["${EMPTY-d}", ""],
		["${SET:+alt}", "alt"],
		["${MISSING:+alt}", ""],
		["${MISSING}", ""],
		["$$literal", "$literal"],
		["${MISSING:?required}", null],
		["${SET:?required}", "value"],
		["${${NESTED}}", null],
	];
	for (const [input, expected] of cases) {
		it(`${input} -> ${expected}`, () => {
			expect(interpolateComposeValue(input, { env })).toBe(expected);
		});
	}
});
