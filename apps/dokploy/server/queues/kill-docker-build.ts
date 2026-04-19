import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";

/**
 * Send SIGINT to the relevant `docker build` / `docker compose` process tree
 * for a deployment target. Used as the final step of a cancel path: the
 * queue aborts the handler's signal, which in turn calls this to tear down
 * the child process the build is running in.
 *
 * Errors are swallowed — a missing process is a no-op, and a failed remote
 * exec shouldn't cascade into the caller.
 */
export async function killDockerBuild(
	type: "application" | "compose",
	serverId: string | null,
): Promise<void> {
	const command =
		type === "application"
			? `pkill -2 -f "docker build"`
			: `pkill -2 -f "docker compose"`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(error);
	}
}
