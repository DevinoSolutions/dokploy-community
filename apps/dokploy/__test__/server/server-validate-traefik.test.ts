import { spawnSync } from "node:child_process";
import { validateTraefik } from "@dokploy/server/setup/server-validate";
import { describe, expect, it } from "vitest";

// A shell function stands in for docker, which answers from the variables set
// above it, so the test runs the same on Linux and Git Bash.
const FAKE_DOCKER = `
docker() {
	case "$1 $2" in
		"service inspect") return 1 ;;
		"container inspect") printf '%s\n' "$FAKE_CONFIG_IMAGE" ;;
		"image inspect")
			case "$*" in
				*RepoTags*) [ -n "$FAKE_TAG" ] && printf '%s\n' "$FAKE_TAG" ;;
				*) printf '%s\n' "$FAKE_LABEL" ;;
			esac ;;
	esac
	return 0
}
`;

const validate = (env: { image: string; tag?: string; label?: string }) => {
	const script = [
		`FAKE_CONFIG_IMAGE='${env.image}'`,
		`FAKE_TAG='${env.tag ?? ""}'`,
		`FAKE_LABEL='${env.label ?? ""}'`,
		FAKE_DOCKER,
		validateTraefik(),
	].join("\n");
	const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trim();
};

const imageId = `sha256:${"0123abcd".repeat(8)}`;

describe("validate server: Traefik version", () => {
	it.each([
		["traefik:v3.7.16", "3.7.16 true"],
		[`traefik:v3.7.16@sha256:${"a".repeat(64)}`, "3.7.16 true"],
		["registry.local:5000/traefik:v3.6.25", "3.6.25 true"],
	])("reads the version from %s", (image, expected) => {
		expect(validate({ image })).toBe(expected);
	});

	it("names a host that runs from an image ID by its tag", () => {
		expect(validate({ image: imageId, tag: "traefik:v3.6.25" })).toBe(
			"3.6.25 true",
		);
	});

	it("falls back to the version label of an image ID", () => {
		expect(validate({ image: imageId, label: "v3.7.16" })).toBe("3.7.16 true");
	});

	it("reports the ID as it was before when nothing names a version", () => {
		expect(validate({ image: imageId })).toBe(`${imageId.slice(7)} true`);
	});
});
