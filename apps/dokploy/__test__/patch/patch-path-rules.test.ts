import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7878: patch file paths and the service a patch belongs to. The rules,
// the API schemas, and every patch router input that takes a path or a patch.

const mocks = vi.hoisted(() => ({
	createPatch: vi.fn(),
	updatePatch: vi.fn(),
	deletePatch: vi.fn(),
	findPatchById: vi.fn(),
	findPatchByFilePath: vi.fn(),
	markPatchForDeletion: vi.fn(),
	readPatchRepoDirectory: vi.fn(),
	readPatchRepoFile: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	cleanPatchRepos: vi.fn(),
	createPatch: mocks.createPatch,
	deletePatch: mocks.deletePatch,
	ensurePatchRepo: vi.fn(),
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findPatchByFilePath: mocks.findPatchByFilePath,
	findPatchById: mocks.findPatchById,
	findPatchesByEntityId: vi.fn(),
	isPatchOnSeveralServices: (p: {
		applicationId: string | null;
		composeId: string | null;
	}) => !!p.applicationId && !!p.composeId,
	markPatchForDeletion: mocks.markPatchForDeletion,
	readPatchRepoDirectory: mocks.readPatchRepoDirectory,
	readPatchRepoFile: mocks.readPatchRepoFile,
	updatePatch: mocks.updatePatch,
}));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

const { getPatchPathError, isSafePatchPath, resolvePatchPath } = await import(
	"@dokploy/server/utils/patch-path"
);
const { apiCreatePatch, apiUpdatePatch } = await import(
	"@dokploy/server/db/schema"
);
const { patchRouter } = await import("@/server/api/routers/patch");

const caller = patchRouter.createCaller({
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "ops@example.com", role: "owner" },
} as unknown as Parameters<typeof patchRouter.createCaller>[0]);

const REFUSED = [
	"",
	"/abs/x",
	"~/x",
	"~user/x",
	".",
	"..",
	"../x",
	"../../../../../x",
	"a/../../x",
	"a/..",
	"./a",
	"a/./b",
	"a/.",
	"a//b",
	"a/",
	"a\\b",
	"..\\..\\x",
	"a\u0000b",
	"a\nb",
	".git",
	".git/HEAD",
	".git/config",
	".git/objects/x",
	".git/hooks/x",
	".GIT/HEAD",
	".Git/config",
	"sub/.git/HEAD",
	".git./HEAD",
	".git /HEAD",
	"GIT~1/HEAD",
	`${"a/".repeat(2100)}x`,
];

const ACCEPTED = [
	"src/a.ts",
	"docker-compose.yml",
	"a/.github/x",
	".github/workflows/ci.yml",
	".env.example",
	".env",
	".gitignore",
	".gitmodules",
	"a/.gitkeep",
	"dir.git/x",
	"..config",
	"a..b/c",
	"deep/nested/path/file.json",
	"name with spaces.txt",
	"ünïcode/файл.txt",
];

describe("patch path rules", () => {
	it.each(REFUSED)("refuses %j", (path) => {
		expect(getPatchPathError(path)).not.toBeNull();
		expect(isSafePatchPath(path)).toBe(false);
	});

	it.each(ACCEPTED)("accepts %j", (path) => {
		expect(getPatchPathError(path)).toBeNull();
	});

	it("refuses anything that is not a string", () => {
		for (const value of [null, undefined, 1, {}, ["a"]]) {
			expect(isSafePatchPath(value)).toBe(false);
		}
	});

	it("joins an accepted path under its base and refuses the rest", () => {
		expect(
			resolvePatchPath("/etc/dokploy/compose/app/code", "src/a.ts").replace(
				/\\/g,
				"/",
			),
		).toBe("/etc/dokploy/compose/app/code/src/a.ts");
		for (const path of ["../x", ".git/HEAD", "/abs/x"]) {
			expect(() =>
				resolvePatchPath("/etc/dokploy/compose/app/code", path),
			).toThrow(/Invalid patch file path/);
		}
	});

	it("says why, without echoing the path", () => {
		const path = "../../../../somedir/x";
		const reason = getPatchPathError(path);
		expect(reason).toMatch(/leaves the repository/);
		expect(reason).not.toContain("somedir");
	});
});

describe("patch API schemas", () => {
	it.each(["../x", ".git/HEAD", "/abs/x"])(
		"create and update refuse %j",
		(filePath) => {
			expect(
				apiCreatePatch.safeParse({ filePath, content: "x", composeId: "c1" })
					.success,
			).toBe(false);
			expect(
				apiUpdatePatch.safeParse({ patchId: "p1", filePath }).success,
			).toBe(false);
		},
	);

	it("create accepts a nested path, update one without a path", () => {
		expect(
			apiCreatePatch.safeParse({
				filePath: "src/a.ts",
				content: "x",
				composeId: "c1",
			}).success,
		).toBe(true);
		expect(
			apiUpdatePatch.safeParse({ patchId: "p1", content: "y" }).success,
		).toBe(true);
	});
});

describe("a patch belongs to exactly one service", () => {
	const base = { filePath: "src/a.ts", content: "x" };

	it("create needs exactly one of applicationId and composeId", () => {
		expect(apiCreatePatch.safeParse({ ...base, composeId: "c1" }).success).toBe(
			true,
		);
		expect(
			apiCreatePatch.safeParse({ ...base, applicationId: "a1" }).success,
		).toBe(true);
		expect(apiCreatePatch.safeParse(base).success).toBe(false);
		expect(
			apiCreatePatch.safeParse({
				...base,
				applicationId: "a1",
				composeId: "c1",
			}).success,
		).toBe(false);
	});

	it("update cannot move a patch to another service", () => {
		const parsed = apiUpdatePatch.parse({
			patchId: "p1",
			content: "y",
			applicationId: "a2",
			composeId: "c2",
		});
		expect(parsed).not.toHaveProperty("applicationId");
		expect(parsed).not.toHaveProperty("composeId");
	});
});

describe("patch router inputs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findApplicationById.mockResolvedValue({ serverId: null });
		mocks.findComposeById.mockResolvedValue({ serverId: null });
		mocks.findPatchByFilePath.mockResolvedValue(undefined);
		mocks.findPatchById.mockResolvedValue({
			patchId: "p1",
			filePath: "src/a.ts",
			composeId: "c1",
			applicationId: null,
		});
		mocks.createPatch.mockImplementation(async (input) => ({
			patchId: "p-new",
			...input,
		}));
		mocks.updatePatch.mockResolvedValue({ patchId: "p1" });
		mocks.markPatchForDeletion.mockResolvedValue({ patchId: "p1" });
		mocks.readPatchRepoFile.mockResolvedValue("file");
		mocks.readPatchRepoDirectory.mockResolvedValue([]);
	});

	const service = { id: "c1", type: "compose" as const };
	const refusedPaths = [
		"../../../../../x",
		".git/HEAD",
		".GIT/objects/x",
		"/abs/x",
	];

	const expectNothingDone = () => {
		expect(mocks.createPatch).not.toHaveBeenCalled();
		expect(mocks.updatePatch).not.toHaveBeenCalled();
		expect(mocks.markPatchForDeletion).not.toHaveBeenCalled();
		expect(mocks.readPatchRepoFile).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	};

	it.each(refusedPaths)(
		"every input refuses %j before doing anything",
		async (filePath) => {
			const calls = [
				caller.create({ filePath, content: "x", composeId: "c1" }),
				caller.update({ patchId: "p1", filePath }),
				caller.saveFileAsPatch({ ...service, filePath, content: "x" }),
				caller.markFileForDeletion({ ...service, filePath }),
				caller.readRepoFile({ ...service, filePath }),
			];
			for (const call of calls) {
				await expect(call).rejects.toMatchObject({ code: "BAD_REQUEST" });
			}
			expectNothingDone();
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		},
	);

	it("keeps working for ordinary paths, with the same gates and audit", async () => {
		for (const filePath of ["src/a.ts", "a/.github/x", ".env.example"]) {
			await caller.saveFileAsPatch({ ...service, filePath, content: "x" });
			await caller.markFileForDeletion({ ...service, filePath });
			await caller.readRepoFile({ ...service, filePath });
		}
		await caller.create({
			filePath: "docker-compose.yml",
			content: "x",
			composeId: "c1",
		});
		expect(mocks.createPatch).toHaveBeenCalledTimes(4);
		expect(mocks.markPatchForDeletion).toHaveBeenCalledTimes(3);
		expect(mocks.readPatchRepoFile).toHaveBeenCalledWith(
			"c1",
			"compose",
			"a/.github/x",
		);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"c1",
			{ service: ["create"] },
		);
		expect(mocks.audit).toHaveBeenCalled();
	});

	it("readRepoDirectories never uses the client's repoPath", async () => {
		await caller.readRepoDirectories({
			...service,
			repoPath: "/etc/dokploy/patch-repos/compose/another-service",
		});
		await caller.readRepoDirectories({ ...service, repoPath: "/" });
		await caller.readRepoDirectories(service);
		for (const call of mocks.readPatchRepoDirectory.mock.calls) {
			expect(call).toEqual(["c1", "compose"]);
		}
		expect(mocks.readPatchRepoDirectory).toHaveBeenCalledTimes(3);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"c1",
			{ service: ["read"] },
		);
	});
});

describe("patch router with a patch on more than one service", () => {
	const twoServices = {
		patchId: "p-two",
		filePath: "docker-compose.yml",
		applicationId: "a1",
		composeId: "c1",
		type: "update",
	};
	// The caller may act on the compose c1 only.
	const onlyCompose = async (_ctx: unknown, serviceId: string) => {
		if (serviceId !== "c1") {
			throw Object.assign(new Error("UNAUTHORIZED"), { code: "UNAUTHORIZED" });
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findPatchById.mockResolvedValue(twoServices);
		mocks.findPatchByFilePath.mockResolvedValue(twoServices);
		mocks.checkServicePermissionAndAccess.mockImplementation(onlyCompose);
		mocks.deletePatch.mockResolvedValue(twoServices);
		mocks.updatePatch.mockResolvedValue(twoServices);
	});

	it("create refuses both ids before any check", async () => {
		await expect(
			caller.create({
				filePath: "docker-compose.yml",
				content: "x",
				applicationId: "a1",
				composeId: "c1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.createPatch).not.toHaveBeenCalled();
	});

	it("can be deleted with delete permission on either of its services", async () => {
		await caller.delete({ patchId: "p-two" });
		expect(mocks.deletePatch).toHaveBeenCalledWith("p-two");
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"c1",
			{ service: ["delete"] },
		);
	});

	it("is not deleted without permission on any of its services", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			Object.assign(new Error("UNAUTHORIZED"), { code: "UNAUTHORIZED" }),
		);
		await expect(caller.delete({ patchId: "p-two" })).rejects.toThrow();
		expect(mocks.deletePatch).not.toHaveBeenCalled();
	});

	it("refuses update, toggle and save-as-patch on it", async () => {
		await expect(
			caller.update({ patchId: "p-two", content: "y" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.toggleEnabled({ patchId: "p-two", enabled: false }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.saveFileAsPatch({
				id: "c1",
				type: "compose",
				filePath: "docker-compose.yml",
				content: "y",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updatePatch).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("keeps a single-service patch on its own service's permission", async () => {
		mocks.findPatchById.mockResolvedValue({
			...twoServices,
			composeId: null,
		});
		await expect(caller.delete({ patchId: "p-two" })).rejects.toThrow();
		expect(mocks.deletePatch).not.toHaveBeenCalled();
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledTimes(1);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"a1",
			{ service: ["delete"] },
		);
	});
});
