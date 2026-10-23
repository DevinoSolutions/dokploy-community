import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SECRET_MARK,
	secretApplicationRow,
	secretComposeRow,
	secretPostgresRow,
} from "./fixtures";

const state = vi.hoisted(() => ({
	application: null as unknown,
	compose: null as unknown,
	postgres: null as unknown,
	checkServiceAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return { ...actual, checkServiceAccess: state.checkServiceAccess };
});

vi.mock("@dokploy/server/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/index")>();
	return {
		...actual,
		findApplicationById: vi.fn(async () => state.application),
		findComposeById: vi.fn(async () => state.compose),
		findPostgresById: vi.fn(async () => state.postgres),
	};
});

vi.mock("@dokploy/server/services/git-provider", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/git-provider")
		>();
	return { ...actual, canEditDeployGitSource: vi.fn(async () => true) };
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

const leaks = (value: unknown) => JSON.stringify(value).includes(SECRET_MARK);

beforeEach(() => {
	state.application = secretApplicationRow();
	state.compose = secretComposeRow();
	state.postgres = secretPostgresRow();
	state.checkServiceAccess.mockClear();
});

describe("application.one", () => {
	it("keeps the dashboard behaviour when includeEnv is not passed", async () => {
		const result = await caller.application.one({ applicationId: "app-1" });
		expect(result.env).toBe("API_KEY=SECRET-env-api\nPLAIN=ok");
		expect(result.buildArgs).toBe("NPM_TOKEN=SECRET-build-arg");
		expect(result.previewEnv).toContain(SECRET_MARK);
		expect(
			(result.github as Record<string, unknown> | null)?.githubClientSecret,
		).toContain(SECRET_MARK);
		expect(result).not.toHaveProperty("secretsRedacted");
		expect(result.hasGitProviderAccess).toBe(true);
	});

	it("keeps values when includeEnv is true", async () => {
		const result = await caller.application.one({
			applicationId: "app-1",
			includeEnv: true,
		});
		expect(result.env).toContain(SECRET_MARK);
	});

	it("strips every secret field when includeEnv is false", async () => {
		const result = await caller.application.one({
			applicationId: "app-1",
			includeEnv: false,
		});
		expect(leaks(result)).toBe(false);
		expect(result.env).toBe("");
		expect(result).toMatchObject({
			secretsRedacted: true,
			applicationId: "app-1",
			hasGitProviderAccess: true,
		});
	});
});

describe("compose.one", () => {
	it("keeps the dashboard behaviour by default", async () => {
		const result = await caller.compose.one({ composeId: "comp-1" });
		expect(result.env).toBe("DB_PASSWORD=SECRET-compose-env");
		expect(result.backups[0]?.destination.encryptionKey).toContain(SECRET_MARK);
	});

	it("strips every secret field when includeEnv is false", async () => {
		const result = await caller.compose.one({
			composeId: "comp-1",
			includeEnv: false,
		});
		expect(leaks(result)).toBe(false);
		expect(result.composeFile).toContain("image: nginx");
	});
});

describe("postgres.one", () => {
	it("keeps the dashboard behaviour by default and strips on false", async () => {
		const full = await caller.postgres.one({ postgresId: "pg-1" });
		expect(full.databasePassword).toBe("SECRET-db-pass");
		const stripped = await caller.postgres.one({
			postgresId: "pg-1",
			includeEnv: false,
		});
		expect(leaks(stripped)).toBe(false);
		expect(stripped.databaseUser).toBe("app");
	});
});

describe("envKeys", () => {
	it("application.envKeys returns names only", async () => {
		state.application = {
			...secretApplicationRow(),
			env: '# comment\nexport A=SECRET-1\nB="SECRET-\nmulti"\nC=\nA=SECRET-dup',
			buildArgs: "ARG_ONE=SECRET-2",
			buildSecrets: null,
		};
		const result = await caller.application.envKeys({ applicationId: "app-1" });
		expect(result).toEqual({
			env: ["A", "B", "C"],
			buildArgs: ["ARG_ONE"],
			buildSecrets: [],
		});
		expect(leaks(result)).toBe(false);
	});

	it("compose.envKeys returns names only", async () => {
		const result = await caller.compose.envKeys({ composeId: "comp-1" });
		expect(result).toEqual({ env: ["DB_PASSWORD"] });
		expect(leaks(result)).toBe(false);
	});

	it("uses the same read check and organization check as .one", async () => {
		await caller.application.envKeys({ applicationId: "app-1" });
		expect(state.checkServiceAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			"read",
		);
		state.checkServiceAccess.mockRejectedValueOnce(
			new TRPCError({ code: "UNAUTHORIZED", message: "no" }),
		);
		await expect(
			caller.compose.envKeys({ composeId: "comp-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		const foreign = secretApplicationRow();
		foreign.environment.project.organizationId = "org-other";
		state.application = foreign;
		await expect(
			caller.application.envKeys({ applicationId: "app-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		const foreignCompose = secretComposeRow();
		foreignCompose.environment.project.organizationId = "org-other";
		state.compose = foreignCompose;
		await expect(
			caller.compose.envKeys({ composeId: "comp-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
