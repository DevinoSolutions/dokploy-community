// The swarm nodes are the cluster's, not a service's: only owners and admins
// may list them. A member's Containers tab works from the services, tasks and
// stats they can read, so it must not wait for (or fail on) the nodes query.
export const canListSwarmNodes = (role: string | undefined) =>
	role === "owner" || role === "admin";

export const swarmQueryGates = ({
	role,
	nodesLoaded,
	nodesError,
}: {
	role: string | undefined;
	nodesLoaded: boolean;
	nodesError: boolean;
}) => {
	const listNodes = canListSwarmNodes(role);
	return {
		// an admin waits for the nodes (no swarm, no services); a member never does
		appsEnabled: listNodes ? !nodesError && nodesLoaded : true,
		// the page needs the nodes to tell "no swarm" from "no services"
		requiresNodes: listNodes,
	};
};
