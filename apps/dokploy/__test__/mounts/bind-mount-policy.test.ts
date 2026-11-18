import { paths } from "@dokploy/server/constants";
import {
	evaluateBindMountHostPath,
	evaluateBindMountPermissions,
	getUnsafePermissionTargetReason,
	isCanonicalHostPath,
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
			`${remote.COMPOSE_PATH}/my-stack-abc123/code/data`,
			"/srv/data",
			"/srv/app/data",
			"/mnt/disk1/data",
			"/data",
			"/home/deploy/data",
			"/var/lib/myapp",
			"/var/data",
			"/opt/app",
			"/home/deploy/.config/app",
		]) {
			expect(getUnsafePermissionTargetReason(target)).toBeNull();
		}
	});

	it.each([
		"/var/lib/docker/volumes/x/_data",
		"/var/lib/containerd",
		"/var/lib/containerd/io",
		"/var/lib/kubelet/pods",
		"/var/lib/dpkg",
		"/var/log",
		"/var/log/app",
		"/var/spool/cron",
		"/snap",
		"/snap/core",
		"/lost+found",
		"/home/deploy/.ssh",
		"/home/deploy/.ssh/id_ed25519",
		"/srv/app/.ssh",
		"/data/.ssh/keys",
	])("refuses %s", (target) => {
		expect(getUnsafePermissionTargetReason(target)).toEqual(expect.any(String));
	});

	it.each([
		"/srv/data/",
		"/srv//data",
		"/srv/./data",
		"/srv/other/../data",
		"/srv/link/..",
		"/srv/data/..",
	])("refuses %s because it is not in canonical form", (target) => {
		expect(getUnsafePermissionTargetReason(target)).toMatch(/canonical/);
	});
});

describe("isCanonicalHostPath", () => {
	it("is true only for a path that normalizes to itself", () => {
		expect(isCanonicalHostPath("/srv/data")).toBe(true);
		expect(isCanonicalHostPath("/")).toBe(true);
		expect(isCanonicalHostPath("/srv/data/")).toBe(false);
		expect(isCanonicalHostPath("/srv/a/../b")).toBe(false);
		expect(isCanonicalHostPath("srv/data")).toBe(false);
	});
});

const base = {
	privilegedRole: false,
	hostReach: true,
};

describe("evaluateBindMountHostPath", () => {
	it.each([
		"/",
		"/var/run/docker.sock",
		"//var//run//docker.sock",
		"/var/run/../run/docker.sock",
		"/etc",
		"/srv/data",
		`${remote.APPLICATIONS_PATH}/app-1`,
		`${remote.APPLICATIONS_PATH}/app-1/files/data`,
		`${remote.COMPOSE_PATH}/app-1/code`,
		`${remote.APPLICATIONS_PATH}/app-1/../app-2`,
		`${remote.SSH_PATH}`,
	])(
		"refuses a member binding %s, the service's own directories included",
		(hostPath) => {
			expect(evaluateBindMountHostPath({ ...base, hostPath })).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: expect.stringMatching(/owner or admin/i),
			});
		},
	);

	it("lets an owner or admin bind any absolute host path", () => {
		for (const hostPath of ["/", "/var/run/docker.sock", "/srv/data", "/etc"]) {
			expect(
				evaluateBindMountHostPath({ ...base, privilegedRole: true, hostPath }),
			).toEqual({ ok: true, hostPath });
		}
	});

	it("hands back the normalized path", () => {
		expect(
			evaluateBindMountHostPath({
				...base,
				privilegedRole: true,
				hostPath: "//srv/./data/",
			}),
		).toEqual({ ok: true, hostPath: "/srv/data" });
	});

	it.each(["", "relative", "./data", "../etc", "~/data"])(
		"answers a bad request for the non-absolute path %j, whoever asks",
		(hostPath) => {
			for (const privilegedRole of [true, false]) {
				expect(
					evaluateBindMountHostPath({ ...base, privilegedRole, hostPath }),
				).toEqual({
					ok: false,
					code: "BAD_REQUEST",
					message: expect.any(String),
				});
			}
		},
	);

	it("keeps an admin of an organization that does not own the host off every path of it, the service's own directories included", () => {
		for (const hostPath of [
			"/var/run/docker.sock",
			`${remote.APPLICATIONS_PATH}/app-1/files`,
		]) {
			expect(
				evaluateBindMountHostPath({
					...base,
					privilegedRole: true,
					hostReach: false,
					hostPath,
				}),
			).toEqual({
				ok: false,
				code: "FORBIDDEN",
				message: expect.stringMatching(/owns this Dokploy instance/i),
			});
		}
	});
});

describe("evaluateBindMountPermissions", () => {
	it("refuses a dangerous path for everyone, owners included", () => {
		for (const privilegedRole of [true, false]) {
			for (const hostPath of [
				"/",
				"/etc",
				"/var/run/docker.sock",
				"/home",
				remote.BASE_PATH,
			]) {
				expect(
					evaluateBindMountPermissions({ ...base, privilegedRole, hostPath })
						.ok,
				).toBe(false);
			}
		}
		expect(
			evaluateBindMountPermissions({
				...base,
				privilegedRole: true,
				hostPath: "/etc",
			}),
		).toMatchObject({ code: "FORBIDDEN" });
	});

	it("answers a bad request for a path that is not canonical", () => {
		for (const hostPath of ["//", "/srv/data/", "/srv/../etc", "/srv/a/./b"]) {
			expect(
				evaluateBindMountPermissions({
					...base,
					privilegedRole: true,
					hostPath,
				}),
			).toMatchObject({ ok: false, code: "BAD_REQUEST" });
		}
	});

	it("lets an owner or admin change permissions on an ordinary canonical path", () => {
		expect(
			evaluateBindMountPermissions({
				...base,
				privilegedRole: true,
				hostPath: "/srv/data",
			}),
		).toEqual({ ok: true, hostPath: "/srv/data" });
	});

	it("lets a member change no permissions, whatever the path", () => {
		for (const hostPath of [
			`${remote.APPLICATIONS_PATH}/app-1/files`,
			"/srv/data",
		]) {
			expect(evaluateBindMountPermissions({ ...base, hostPath })).toMatchObject(
				{
					ok: false,
					code: "FORBIDDEN",
					message: expect.stringMatching(/owner or admin/i),
				},
			);
		}
	});
});
