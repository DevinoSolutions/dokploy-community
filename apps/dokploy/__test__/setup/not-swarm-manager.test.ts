import { isNotSwarmManagerError } from "@dokploy/server/setup/setup";
import { describe, expect, it } from "vitest";

// Sentry DOKPLOY-COMMUNITY-2M: on a host whose Docker daemon is not a swarm
// manager, creating the overlay "dokploy-network" at boot fails with this
// docker-modem error. It was sent to Sentry on every start.
describe("isNotSwarmManagerError", () => {
	it("matches the docker-modem error for a non-manager node", () => {
		const error = new Error(
			'(HTTP code 403) unexpected - This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again. ',
		);

		expect(isNotSwarmManagerError(error)).toBe(true);
	});

	it("does not match other docker failures", () => {
		expect(
			isNotSwarmManagerError(
				new Error("(HTTP code 403) forbidden - access denied"),
			),
		).toBe(false);
		expect(
			isNotSwarmManagerError(
				new Error(
					"(HTTP code 409) conflict - network with name dokploy-network already exists",
				),
			),
		).toBe(false);
	});

	it("ignores values that are not errors", () => {
		expect(isNotSwarmManagerError("This node is not a swarm manager")).toBe(
			false,
		);
		expect(isNotSwarmManagerError(undefined)).toBe(false);
	});
});
