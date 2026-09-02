import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findScheduleById: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	findBackupById: vi.fn(),
	findVolumeBackupById: vi.fn(),
}));

vi.mock("@dokploy/server", () => mocks);

import { resolveDeploymentAllByTypeAuthTarget } from "@/server/utils/deployment-all-by-type-target";

describe("resolveDeploymentAllByTypeAuthTarget", () => {
	beforeEach(() => {
		mocks.findScheduleById.mockReset();
		mocks.findPreviewDeploymentById.mockReset();
		mocks.findBackupById.mockReset();
		mocks.findVolumeBackupById.mockReset();
	});

	describe("application / compose (id is already the service id)", () => {
		it("returns the id verbatim for application", async () => {
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "app-1",
				type: "application",
			});
			expect(target).toEqual({ kind: "service", serviceId: "app-1" });
		});

		it("returns the id verbatim for compose", async () => {
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "compose-1",
				type: "compose",
			});
			expect(target).toEqual({ kind: "service", serviceId: "compose-1" });
		});
	});

	describe("server (id is a server id)", () => {
		it("returns a server target", async () => {
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "server-1",
				type: "server",
			});
			expect(target).toEqual({ kind: "server", serverId: "server-1" });
		});
	});

	describe("schedule", () => {
		it("resolves to the schedule's applicationId when set", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "application",
				applicationId: "app-2",
				composeId: null,
				serverId: null,
				organizationId: "org-1",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-1",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "service", serviceId: "app-2" });
		});

		it("resolves to composeId when applicationId is absent", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "compose",
				applicationId: null,
				composeId: "compose-3",
				serverId: null,
				organizationId: "org-1",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-2",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "service", serviceId: "compose-3" });
		});

		it("falls back to serverId for a server-only schedule", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "server",
				applicationId: null,
				composeId: null,
				serverId: "server-2",
				organizationId: "org-1",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-3",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "server", serverId: "server-2" });
		});

		// A `dokploy-server` schedule runs on the Dokploy host itself: no
		// applicationId, no composeId, no serverId — only an organizationId.
		// Failing this one closed would break /dashboard/schedules.
		it("falls back to the organization for a dokploy-server schedule", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "dokploy-server",
				applicationId: null,
				composeId: null,
				serverId: null,
				organizationId: "org-1",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-4",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "organization", organizationId: "org-1" });
		});

		it("surfaces a null organizationId so the router can fail closed", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "dokploy-server",
				applicationId: null,
				composeId: null,
				serverId: null,
				organizationId: null,
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-5",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "organization", organizationId: null });
		});

		it("returns 'none' for a service-typed schedule with nothing attached", async () => {
			mocks.findScheduleById.mockResolvedValue({
				scheduleType: "application",
				applicationId: null,
				composeId: null,
				serverId: null,
				organizationId: "org-1",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "schedule-6",
				type: "schedule",
			});
			expect(target).toEqual({ kind: "none" });
		});
	});

	describe("previewDeployment (regression — the modal-KO case)", () => {
		it("resolves to the preview's applicationId when set", async () => {
			mocks.findPreviewDeploymentById.mockResolvedValue({
				applicationId: "app-3",
				composeId: null,
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "preview-1",
				type: "previewDeployment",
			});
			expect(target).toEqual({ kind: "service", serviceId: "app-3" });
		});

		it("resolves to composeId when applicationId is absent", async () => {
			mocks.findPreviewDeploymentById.mockResolvedValue({
				applicationId: null,
				composeId: "compose-4",
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "preview-2",
				type: "previewDeployment",
			});
			expect(target).toEqual({ kind: "service", serviceId: "compose-4" });
		});

		it("returns 'none' when the preview has no attached service", async () => {
			mocks.findPreviewDeploymentById.mockResolvedValue({
				applicationId: null,
				composeId: null,
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "preview-3",
				type: "previewDeployment",
			});
			expect(target).toEqual({ kind: "none" });
		});
	});

	describe("backup", () => {
		it("resolves through composeId, then the six database id columns", async () => {
			const cases = [
				["composeId", "compose-5"],
				["postgresId", "pg-1"],
				["mysqlId", "my-1"],
				["mariadbId", "maria-1"],
				["mongoId", "mongo-1"],
				["libsqlId", "libsql-1"],
			] as const;
			for (const [column, id] of cases) {
				mocks.findBackupById.mockResolvedValueOnce({
					composeId: null,
					postgresId: null,
					mysqlId: null,
					mariadbId: null,
					mongoId: null,
					libsqlId: null,
					[column]: id,
				});
				const target = await resolveDeploymentAllByTypeAuthTarget({
					id: "backup-x",
					type: "backup",
				});
				expect(target).toEqual({ kind: "service", serviceId: id });
			}
		});

		it("returns 'none' when a backup has no attached service", async () => {
			mocks.findBackupById.mockResolvedValue({
				composeId: null,
				postgresId: null,
				mysqlId: null,
				mariadbId: null,
				mongoId: null,
				libsqlId: null,
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "backup-orphan",
				type: "backup",
			});
			expect(target).toEqual({ kind: "none" });
		});
	});

	describe("volumeBackup", () => {
		it("resolves through applicationId, composeId and the six database id columns", async () => {
			const cases = [
				["applicationId", "app-4"],
				["composeId", "compose-6"],
				["postgresId", "pg-2"],
				["mysqlId", "my-2"],
				["mariadbId", "maria-2"],
				["mongoId", "mongo-2"],
				["redisId", "redis-1"],
				["libsqlId", "libsql-2"],
			] as const;
			for (const [column, id] of cases) {
				mocks.findVolumeBackupById.mockResolvedValueOnce({
					applicationId: null,
					composeId: null,
					postgresId: null,
					mysqlId: null,
					mariadbId: null,
					mongoId: null,
					redisId: null,
					libsqlId: null,
					[column]: id,
				});
				const target = await resolveDeploymentAllByTypeAuthTarget({
					id: "volumeBackup-x",
					type: "volumeBackup",
				});
				expect(target).toEqual({ kind: "service", serviceId: id });
			}
		});

		it("returns 'none' when a volume backup has no attached service", async () => {
			mocks.findVolumeBackupById.mockResolvedValue({
				applicationId: null,
				composeId: null,
				postgresId: null,
				mysqlId: null,
				mariadbId: null,
				mongoId: null,
				redisId: null,
				libsqlId: null,
			});
			const target = await resolveDeploymentAllByTypeAuthTarget({
				id: "volumeBackup-orphan",
				type: "volumeBackup",
			});
			expect(target).toEqual({ kind: "none" });
		});
	});
});
