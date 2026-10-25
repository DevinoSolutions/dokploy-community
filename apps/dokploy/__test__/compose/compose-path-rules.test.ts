import { apiUpdateCompose } from "@dokploy/server/db/schema";
import {
	assertSafeComposePath,
	COMPOSE_PATH_MAX_LENGTH,
	getComposePathError,
	getStoredComposePathError,
} from "@dokploy/server/utils/compose-path";
import { describe, expect, it } from "vitest";

// The compose path rules (T-8238): what the API accepts, and what a path
// stored before the rules may still hold at deploy time.

// Accepted when saved, and at deploy time.
const ACCEPTED = [
	"./docker-compose.yml",
	"docker-compose.yml",
	"compose.yaml",
	"deploy/docker-compose.prod.yml",
	"./stacks/api/docker-compose.yml",
	"./deploy/./docker-compose.yml",
	"my stack/docker-compose.yml",
	"a..b/docker-compose.yml",
	"..docker-compose.yml",
	"docker_compose-v2.yml",
	"x".repeat(COMPOSE_PATH_MAX_LENGTH),
];

// Refused when saved and at deploy time.
const UNSAFE = [
	"",
	"   ",
	"/etc/dokploy/compose/other/code/docker-compose.yml",
	"~/docker-compose.yml",
	"..",
	"../other/code/docker-compose.yml",
	"deploy/../../other/docker-compose.yml",
	"./..",
	"compose.yml;true",
	"$(true).yml",
	"${HOME}.yml",
	"`true`.yml",
	"a|b.yml",
	"a&b.yml",
	"a>b.yml",
	"a<b.yml",
	"(a).yml",
	"a'b.yml",
	'a"b.yml',
	"deploy\\docker-compose.yml",
	"a\nb.yml",
	"a\rb.yml",
	"a\tb.yml",
	"a\u0000b.yml",
	"a\u007fb.yml",
];

// Refused when saved, but a stored one still deploys: harmless once quoted.
const SAVED_ONLY = [
	"déploiement/docker-compose.yml",
	"compose[prod].yml",
	"compose,prod.yml",
	"compose@prod.yml",
	"compose+prod.yml",
	"compose#1.yml",
	"compose:prod.yml",
	" docker-compose.yml",
	"docker-compose.yml ",
	"-docker-compose.yml",
	"deploy/",
	"x".repeat(COMPOSE_PATH_MAX_LENGTH + 1),
];

describe("compose path rules", () => {
	it.each(ACCEPTED)("accepts %j", (path) => {
		expect(getComposePathError(path)).toBeNull();
		expect(getStoredComposePathError(path)).toBeNull();
		expect(() => assertSafeComposePath(path)).not.toThrow();
	});

	it.each(UNSAFE)("refuses %j everywhere", (path) => {
		expect(getComposePathError(path)).not.toBeNull();
		expect(getStoredComposePathError(path)).not.toBeNull();
		expect(() => assertSafeComposePath(path)).toThrow(/^Compose refused: /);
	});

	it.each(SAVED_ONLY)("refuses %j when saved, keeps it when stored", (path) => {
		expect(getComposePathError(path)).not.toBeNull();
		expect(getStoredComposePathError(path)).toBeNull();
	});

	it("refuses a value that is not a string", () => {
		for (const value of [undefined, null, 42, {}]) {
			expect(getStoredComposePathError(value)).toBe(
				"the compose path is empty",
			);
		}
	});

	it("says what to change, without repeating the stored value", () => {
		const path = "../other/code/docker-compose.yml";
		expect(() => assertSafeComposePath(path)).toThrow(
			"Compose refused: the compose path leaves the repository. Set the compose path in the compose's settings to a relative path inside the repository, such as ./docker-compose.yml, and deploy again.",
		);
		try {
			assertSafeComposePath(path);
		} catch (error) {
			expect((error as Error).message).not.toContain("other/code");
		}
	});
});

describe("compose.update input", () => {
	it("takes a sensible compose path", () => {
		for (const composePath of ACCEPTED) {
			expect(
				apiUpdateCompose.safeParse({ composeId: "c1", composePath }).success,
			).toBe(true);
		}
	});

	it("refuses an unsafe or unusual compose path", () => {
		for (const composePath of [...UNSAFE, ...SAVED_ONLY]) {
			const result = apiUpdateCompose.safeParse({
				composeId: "c1",
				composePath,
			});
			expect(result.success, JSON.stringify(composePath)).toBe(false);
		}
	});

	it("leaves the compose path alone when the update does not set it", () => {
		expect(apiUpdateCompose.safeParse({ composeId: "c1" }).success).toBe(true);
	});
});
