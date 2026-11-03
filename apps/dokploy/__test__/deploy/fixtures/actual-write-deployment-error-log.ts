import { vi } from "vitest";

type DeploymentService = typeof import("@dokploy/server/services/deployment");

/**
 * The tests that replace the whole deployment service with a factory mock still
 * want the real error-log write: they assert on the commands it sends through
 * the (mocked) `execAsync` and `execAsyncRemote`.
 */
export const actualWriteDeploymentErrorLog = async (
	...args: Parameters<DeploymentService["writeDeploymentErrorLog"]>
) => {
	const actual = await vi.importActual<DeploymentService>(
		"@dokploy/server/services/deployment",
	);
	return actual.writeDeploymentErrorLog(...args);
};
