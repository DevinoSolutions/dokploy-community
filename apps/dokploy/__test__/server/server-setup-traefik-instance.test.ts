import { spawnSync } from "node:child_process";
import { createTraefikInstance } from "@dokploy/server/setup/server-setup";
import { TRAEFIK_IMAGE } from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

// Shell functions stand in for docker and sleep: docker answers from the
// variables set above it and prints each call to stderr (stdout feeds the
// script's command substitutions), so the test needs no PATH tricks and runs
// the same on Linux and Git Bash.
const FAKE_DOCKER = `
docker() {
	echo "DOCKER: $*" >&2
	case "$1 $2" in
		"service inspect")
			[ -n "$FAKE_SERVICE_IMAGE" ] || return 1
			case "$*" in *--format*) printf '%s\\n' "$FAKE_SERVICE_IMAGE" ;; esac
			return 0 ;;
		"inspect dokploy-traefik")
			[ "$FAKE_CONTAINER" = 1 ] && return 0
			return 1 ;;
		"container inspect")
			[ "$3" = dokploy-traefik-previous ] && [ "$FAKE_PREVIOUS" = 1 ] && return 0
			return 1 ;;
		"rename dokploy-traefik-previous")
			FAKE_CONTAINER=1 ;;
	esac
	return 0
}
sleep() { :; }
`;

const runSetup = (env: {
	service?: string;
	container?: boolean;
	previous?: boolean;
}) => {
	const script = [
		"set -e",
		"SUDO_CMD=",
		`FAKE_SERVICE_IMAGE='${env.service ?? ""}'`,
		`FAKE_CONTAINER=${env.container ? 1 : 0}`,
		`FAKE_PREVIOUS=${env.previous ? 1 : 0}`,
		FAKE_DOCKER,
		createTraefikInstance(),
	].join("\n");
	const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	const calls = result.stderr
		.split("\n")
		.filter((line) => line.startsWith("DOCKER: "))
		.map((line) => line.slice("DOCKER: ".length));
	return {
		output: result.stdout,
		calls,
		run: calls.find((call) => call.startsWith("run ")),
	};
};

describe("remote server setup: Traefik instance", () => {
	it("creates a missing Traefik from the pin", () => {
		const { run } = runSetup({});

		expect(run?.split(" ").at(-1)).toBe(TRAEFIK_IMAGE);
	});

	it("puts the image after -- so it can't be read as an option", () => {
		const { run } = runSetup({});

		expect(run?.split(" ").slice(-2)).toEqual(["--", TRAEFIK_IMAGE]);
	});

	it("leaves the backup of an update alone and creates no fresh Traefik", () => {
		const { calls, output } = runSetup({ previous: true });

		// A running update owns the backup; Dokploy restores it after setup, in
		// the server's Traefik queue.
		expect(calls.some((call) => call.startsWith("rename "))).toBe(false);
		expect(calls.some((call) => call.startsWith("start "))).toBe(false);
		expect(calls.some((call) => call.startsWith("run "))).toBe(false);
		expect(output).toContain("Dokploy restores it after setup");
	});

	it("ignores a backup while the live container exists", () => {
		const { calls } = runSetup({ container: true, previous: true });

		expect(calls.some((call) => call.startsWith("rename "))).toBe(false);
	});

	it("leaves an existing Traefik container alone", () => {
		const { calls, output } = runSetup({ container: true });

		expect(calls.some((call) => call.startsWith("run "))).toBe(false);
		expect(output).toContain("Traefik already exists");
	});

	it.each([
		"traefik:v3.5.4",
		"traefik:v3.5.4@sha256:abc123",
		"registry.local:5000/traefik:v9.9.9",
	])(
		"migrates a Swarm service running %s to a container with the same image",
		(image) => {
			const { calls, run } = runSetup({ service: image });

			expect(calls).toContain("service rm dokploy-traefik");
			expect(run?.split(" ").at(-1)).toBe(image);
		},
	);

	it.each(["traefik", "localhost:5000/traefik", "sha256:0123abcd"])(
		"does not migrate a Swarm service whose image %s has no readable tag",
		(image) => {
			const { calls, output } = runSetup({ service: image });

			expect(output).toContain("Can't read the version tag");
			expect(calls).not.toContain("service rm dokploy-traefik");
			expect(calls.some((call) => call.startsWith("run "))).toBe(false);
		},
	);
});
