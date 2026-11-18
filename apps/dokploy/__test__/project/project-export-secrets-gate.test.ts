import { beforeEach, describe, expect, it, vi } from "vitest";

// `project.export` with includeSecrets puts env, passwords, tokens and the
// basic-auth passwords of every service of the project into the file. A
// project reader does not get that: only a caller who may edit services does
// (T-19588). Refused with FORBIDDEN, never answered with stripped data.
const state = vi.hoisted(() => ({
	hasPermission: vi.fn(async (_ctx?: unknown, _request?: unknown) => false),
	findProjectById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		hasPermission: state.hasPermission,
		findMemberByUserId: vi.fn(async () => ({
			accessedProjects: ["proj-1"],
		})),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return { ...actual, findProjectById: state.findProjectById };
});

vi.mock("@/server/api/utils/audit", () => ({ audit: state.audit }));

const { projectRouter } = await import("@/server/api/routers/project");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(projectRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

beforeEach(() => {
	state.hasPermission.mockReset();
	state.audit.mockReset();
	state.findProjectById.mockReset();
	state.findProjectById.mockResolvedValue({
		projectId: "proj-1",
		organizationId: "org-1",
		name: "p",
		description: null,
		env: "PROJECT_TOKEN=SECRET-project",
		environments: [],
	});
});

describe("project.export includeSecrets", () => {
	it("refuses a caller who cannot edit services, before reading the project", async () => {
		state.hasPermission.mockResolvedValue(false);
		await expect(
			caller.export({ projectId: "proj-1", includeSecrets: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.findProjectById).not.toHaveBeenCalled();
		expect(state.audit).not.toHaveBeenCalled();
		expect(state.hasPermission).toHaveBeenCalledWith(expect.anything(), {
			service: ["create"],
		});
	});

	it("still lets a reader export without secrets, with them redacted", async () => {
		state.hasPermission.mockResolvedValue(false);
		const result = await caller.export({ projectId: "proj-1" });
		expect(JSON.stringify(result)).not.toContain("SECRET-project");
		expect(result).toMatchObject({ includeSecrets: false });
		expect(state.hasPermission).not.toHaveBeenCalled();
	});

	it("gives the secrets to a caller who can edit services", async () => {
		state.hasPermission.mockResolvedValue(true);
		const result = await caller.export({
			projectId: "proj-1",
			includeSecrets: true,
		});
		expect(JSON.stringify(result)).toContain("SECRET-project");
		expect(result).toMatchObject({ includeSecrets: true });
	});
});
