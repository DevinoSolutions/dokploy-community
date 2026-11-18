import { paths } from "@dokploy/server/constants";
import {
	evaluateBindMountHostPath,
	evaluateBindMountPermissions,
	getUnsafePermissionTargetReason,
	isServiceOwnHostPath,
	normalizeHostPath,
} from "@dokploy/server/utils/docker/bind-mount-policy";
import { describe, expect, it } from "vitest";

const remote = paths(true);
const local = paths(false);

describe("normalizeHostPath", () => {
	it.each([
		["/srv/data", "/srv/data"],
		["/srv/data/", "/srv/data"],
		["//srv//data", "/srv/data"],
		["/srv/./data", "/srv/data"],
		["/srv/other/../data", "/srv/data"],
		["/srv/../../etc", "/etc"],
		["/..", "/"],
		["///", "/"],
		["/var/run/docker.sock/", "/var/run/docker.sock"],
	])("%s becomes %s", (input, expected) => {
		expect(normalizeHostPath(input)).toBe(expected);
	});

	it.each(["", "relative/path", "./data", "../etc", "~/data", "/srv/da\0ta"])(
		"refuses %j",
		(input) => {
			expect(normalizeHostPath(input)).toBeNull();
		},
	);
});

describe("getUnsafePermissionTargetReason", () => {
	it.each([
		"/",
		"//",
		"/etc",
		"/etc/",
		"/etc/passwd",
		"/etc/ssh/sshd_config",
		"/usr",
		"/usr/local/bin",
		"/bin",
		"/sbin",
		"/lib",
		"/lib64",
		"/boot",
		"/dev",
		"/dev/shm",
		"/proc",
		"/proc/1/root",
		"/sys",
		"/run",
		"/run/docker.sock",
		"/var/run",
		"/var/run/docker.sock",
		"/var/lib/docker",
		"/var/lib/docker/volumes",
		"/root",
		"/root/.ssh",
		"/home",
		"/home/",
		"/var",
		"/tmp",
		"/opt",
		"/mnt",
		"/srv",
	])("refuses %s", (target) => {
		expect(getUnsafePermissionTargetReason(target)).toEqual(expect.any(String));
	});

	it.each([
		"/var/run/../run/docker.sock",
		"//var//run//docker.sock",
		"/var/./run/docker.sock",
		"/srv/data/../../var/run/docker.sock",
		"/tmp/../etc",
		"/home/../etc/shadow",
		"/etc/dokploy/../passwd",
		"/data/anything.sock",
		"/data/app.socket",
		"relative/path",
	])("refuses the disguised or special path %s", (target) => {
		expect(getUnsafePermissionTargetReason(target)).toEqual(expect.any(String));
	});

	it("refuses the Dokploy base directories themselves", () => {
		for (const base of [remote, local]) {
			for (const root of [
				base.BASE_PATH,
				base.APPLICATIONS_PATH,
				base.COMPOSE_PATH,
				base.MAIN_TRAEFIK_PATH,
				base.SSH_PATH,
				base.REGISTRY_PATH,
			]) {
				expect(getUnsafePermissionTargetReason(root)).toEqual(
					expect.any(String),
				);
				expect(getUnsafePermissionTargetReason(`${root}/`)).toEqual(
					expect.any(String),
				);
			}
		}
	});

	it("refuses what lives in the Dokploy directories that are not a service's own", () => {
		expect(
			getUnsafePermissionTargetReason(`${remote.SSH_PATH}/id_rsa`),
		).toEqual(expect.any(String));
		expect(
			getUnsafePermissionTargetReason(`${remote.CERTIFICATES_PATH}/x`),
		).toEqual(expect.any(String));
		expect(
			getUnsafePermissionTargetReason(`${remote.APPLICATIONS_PATH}/../ssh`),
		).toEqual(expect.any(String));
	});

	it("accepts a service's own directory and ordinary data paths", () => {
		for (const target of [
			`${remote.APPLICATIONS_PATH}/my-app-abc123`,
			`${remote.APPLICATIONS_PATH}/my-app-abc123/files/data`,
			`${remote.COMPOSE_PATH}/my-stack-abc123/code/data/`,
			"/srv/data",
			"/srv/app/data",
			"/mnt/disk1/data",
			"/data",
			"/home/deploy/data",
			"/var/lib/myapp",
			"/var/data",
			"/opt/app",
		]) {
			expect(getUnsafePermissionTargetReason(target)).toBeNull();
		}
	});
});

describe("isServiceOwnHostPath", () => {
	it("accepts the application and compose directories of the service and below", () => {
		expect(
			isServiceOwnHostPath(
				`${remote.APPLICATIONS_PATH}/app-1/files/data/`,
				"app-1",
				"server-1",
			),
		).toBe(true);
		expect(
			isServiceOwnHostPath(
				`${remote.COMPOSE_PATH}/stack-1/code`,
				"stack-1",
				"server-1",
			),
		).toBe(true);
	});

	// The Dokploy host keeps its directories in /etc/dokploy only in production;
	// elsewhere (and on Windows) the base path is not a POSIX path.
	it.runIf(local.BASE_PATH.startsWith("/"))(
		"uses the directories of the Dokploy host for a service without a server",
		() => {
			expect(
				isServiceOwnHostPath(`${local.APPLICATIONS_PATH}/app-1`, "app-1", null),
			).toBe(true);
			expect(
				getUnsafePermissionTargetReason(`${local.APPLICATIONS_PATH}/app-1`),
			).toBeNull();
			expect(getUnsafePermissionTargetReason(local.APPLICATIONS_PATH)).toEqual(
				expect.any(String),
			);
		},
	);

	it("uses the directories of the host the service runs on", () => {
		expect(
			isServiceOwnHostPath(`${remote.APPLICATIONS_PATH}/app-1`, "app-1", null),
		).toBe(local.BASE_PATH === remote.BASE_PATH);
		expect(
			isServiceOwnHostPath(
				`${remote.APPLICATIONS_PATH}/app-1`,
				"app-1",
				"server-1",
			),
		).toBe(true);
	});

	it("refuses another service, a prefix of the name and an escape", () => {
		const base = remote.APPLICATIONS_PATH;
		expect(isServiceOwnHostPath(`${base}/app-2`, "app-1", "s")).toBe(false);
		expect(isServiceOwnHostPath(`${base}/app-10`, "app-1", "s")).toBe(false);
		expect(isServiceOwnHostPath(`${base}/app-1x/files`, "app-1", "s")).toBe(
			false,
		);
		expect(isServiceOwnHostPath(`${base}/app-1/../app-2`, "app-1", "s")).toBe(
			false,
		);
		expect(isServiceOwnHostPath(`${base}/app-1/../../ssh`, "app-1", "s")).toBe(
			false,
		);
		expect(isServiceOwnHostPath(base, "app-1", "s")).toBe(false);
		expect(isServiceOwnHostPath("/", "app-1", "s")).toBe(false);
		expect(isServiceOwnHostPath(`${base}/app-1`, "", "s")).toBe(false);
		expect(isServiceOwnHostPath(`${base}/app-1`, "../app-1", "s")).toBe(false);
	});
});

const base = {
	appName: "app-1",
	serverId: "server-1",
	privilegedRole: false,
	hostReach: true,
};

describe("evaluateBindMountHostPath", () => {
	it("lets a member bind nothing, not even the service's own directories", () => {
		for (const hostPath of [
			`${remote.APPLICATIONS_PATH}/app-1`,
			`${remote.APPLICATIONS_PATH}/app-1/files/data`,
			`${remote.COMPOSE_PATH}/app-1/code`,
		]) {
			expect(evaluateBindMountHostPath({ ...base, hostPath })).toEqual({
				ok: false,
				message: expect.stringMatching(/owner or admin/i),
			});
		}
	});

	it.each([
		"/",
		"/var/run/docker.sock",
		"//var//run//docker.sock",
		"/var/run/../run/docker.sock",
		"/etc",
		"/srv/data",
		`${remote.APPLICATIONS_PATH}/app-2`,
		`${remote.APPLICATIONS_PATH}/app-1/../app-2`,
		`${remote.SSH_PATH}`,
		"relative",
	])("refuses a member binding %s", (hostPath) => {
		const result = evaluateBindMountHostPath({ ...base, hostPath });
		expect(result.ok).toBe(false);
	});

	it("tells the member why", () => {
		const result = evaluateBindMountHostPath({
			...base,
			hostPath: "/var/run/docker.sock",
		});
		expect(result).toEqual({
			ok: false,
			message: expect.stringMatching(/owner or admin/i),
		});
	});

	it("lets an owner or admin bind any absolute host path", () => {
		for (const hostPath of ["/", "/var/run/docker.sock", "/srv/data", "/etc"]) {
			expect(
				evaluateBindMountHostPath({
					...base,
					privilegedRole: true,
					hostPath,
				}),
			).toEqual({ ok: true, hostPath });
		}
	});

	it("still refuses a relative path for an owner", () => {
		expect(
			evaluateBindMountHostPath({
				...base,
				privilegedRole: true,
				hostPath: "data",
			}).ok,
		).toBe(false);
	});

	it("keeps an admin of an organization that does not own the host off the host", () => {
		const result = evaluateBindMountHostPath({
			...base,
			serverId: null,
			privilegedRole: true,
			hostReach: false,
			hostPath: "/var/run/docker.sock",
		});
		expect(result).toEqual({
			ok: false,
			message: expect.stringMatching(/owns this Dokploy instance/i),
		});
		expect(
			evaluateBindMountHostPath({
				...base,
				privilegedRole: true,
				hostReach: false,
				hostPath: `${remote.APPLICATIONS_PATH}/app-1/files`,
			}).ok,
		).toBe(true);
	});
});

describe("evaluateBindMountPermissions", () => {
	it("refuses a dangerous path for everyone, owners included", () => {
		for (const privilegedRole of [true, false]) {
			for (const hostPath of [
				"/",
				"//",
				"/etc",
				"/var/run/docker.sock",
				"/home",
				remote.BASE_PATH,
			]) {
				const result = evaluateBindMountPermissions({
					...base,
					privilegedRole,
					hostPath,
				});
				expect(result.ok).toBe(false);
			}
		}
	});

	it("lets an owner or admin change permissions on an ordinary path", () => {
		expect(
			evaluateBindMountPermissions({
				...base,
				privilegedRole: true,
				hostPath: "/srv/data/",
			}),
		).toEqual({ ok: true, hostPath: "/srv/data" });
	});

	it("lets a member change no permissions on a bind mount", () => {
		expect(
			evaluateBindMountPermissions({
				...base,
				hostPath: `${remote.APPLICATIONS_PATH}/app-1/files`,
			}).ok,
		).toBe(false);
		const outside = evaluateBindMountPermissions({
			...base,
			hostPath: "/srv/data",
		});
		expect(outside).toEqual({
			ok: false,
			message: expect.stringMatching(/owner or admin/i),
		});
	});
});
