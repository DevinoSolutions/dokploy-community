import { describe, expect, it } from "vitest";
import {
	canListSwarmNodes,
	swarmQueryGates,
} from "@/components/dashboard/swarm/containers/query-gates";

// The swarm Containers tab is the only swarm tab a member sees. The nodes are
// refused to members (T-7064), so the tab must not wait for or fail on them.
describe("swarm containers tab query gates", () => {
	it("asks for the nodes only for an owner or admin", () => {
		expect(canListSwarmNodes("owner")).toBe(true);
		expect(canListSwarmNodes("admin")).toBe(true);
		expect(canListSwarmNodes("member")).toBe(false);
		expect(canListSwarmNodes(undefined)).toBe(false);
	});

	it("lets a member's service queries run without any nodes", () => {
		const gates = swarmQueryGates({
			role: "member",
			nodesLoaded: false,
			nodesError: false,
		});
		expect(gates.appsEnabled).toBe(true);
		expect(gates.requiresNodes).toBe(false);
	});

	it("makes an owner or admin wait for the nodes, and stop when they fail", () => {
		for (const role of ["owner", "admin"]) {
			const gates = (nodesLoaded: boolean, nodesError: boolean) =>
				swarmQueryGates({ role, nodesLoaded, nodesError });
			expect(gates(false, false).appsEnabled).toBe(false);
			expect(gates(true, false).appsEnabled).toBe(true);
			expect(gates(false, true).appsEnabled).toBe(false);
			expect(gates(false, false).requiresNodes).toBe(true);
		}
	});
});
