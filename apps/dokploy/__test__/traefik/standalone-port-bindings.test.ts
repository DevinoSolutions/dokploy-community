import {
	applyAdditionalPortBindings,
	buildStandalonePortBindings,
	TRAEFIK_BIND_IP,
} from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

type Binding = { HostPort: string; HostIp: string };

const bind = (HostPort: string): Binding => ({
	HostPort,
	HostIp: TRAEFIK_BIND_IP,
});

describe("applyAdditionalPortBindings", () => {
	it("keeps every published port sharing one target port", () => {
		const exposedPorts: Record<string, {}> = {};
		const portBindings: Record<string, Binding[]> = {};

		applyAdditionalPortBindings(exposedPorts, portBindings, [
			{ targetPort: 80, publishedPort: 8085, protocol: "tcp" },
			{ targetPort: 80, publishedPort: 8888, protocol: "tcp" },
		]);

		expect(portBindings["80/tcp"]).toEqual([bind("8085"), bind("8888")]);
		expect(exposedPorts["80/tcp"]).toEqual({});
	});

	it("keeps protocols on the same target port separate", () => {
		const exposedPorts: Record<string, {}> = {};
		const portBindings: Record<string, Binding[]> = {};

		applyAdditionalPortBindings(exposedPorts, portBindings, [
			{ targetPort: 53, publishedPort: 5353, protocol: "tcp" },
			{ targetPort: 53, publishedPort: 5354, protocol: "udp" },
		]);

		expect(portBindings["53/tcp"]).toEqual([bind("5353")]);
		expect(portBindings["53/udp"]).toEqual([bind("5354")]);
	});

	it("appends to bindings that already exist instead of overwriting them", () => {
		const exposedPorts: Record<string, {}> = {};
		const portBindings: Record<string, Binding[]> = {
			"80/tcp": [bind("80")],
		};

		applyAdditionalPortBindings(exposedPorts, portBindings, [
			{ targetPort: 80, publishedPort: 8085, protocol: "tcp" },
		]);

		expect(portBindings["80/tcp"]).toEqual([bind("80"), bind("8085")]);
	});

	it("does not bind the same host port twice", () => {
		const exposedPorts: Record<string, {}> = {};
		const portBindings: Record<string, Binding[]> = {
			"8080/tcp": [bind("8080")],
		};

		applyAdditionalPortBindings(exposedPorts, portBindings, [
			{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
		]);

		expect(portBindings["8080/tcp"]).toEqual([bind("8080")]);
	});
});

describe("buildStandalonePortBindings", () => {
	it("default setup binds exactly 80, 443 and 443/udp", () => {
		const { exposedPorts, portBindings } = buildStandalonePortBindings([]);

		expect(JSON.stringify(exposedPorts)).toBe(
			'{"80/tcp":{},"443/tcp":{},"443/udp":{}}',
		);
		expect(JSON.stringify(portBindings)).toBe(
			JSON.stringify({
				"80/tcp": [{ HostPort: "80", HostIp: TRAEFIK_BIND_IP }],
				"443/tcp": [{ HostPort: "443", HostIp: TRAEFIK_BIND_IP }],
				"443/udp": [{ HostPort: "443", HostIp: TRAEFIK_BIND_IP }],
			}),
		);
	});

	it("dashboard enabled binds 8080 exactly once, same as before", () => {
		const { exposedPorts, portBindings } = buildStandalonePortBindings([
			{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
		]);

		expect(JSON.stringify(exposedPorts)).toBe(
			'{"80/tcp":{},"443/tcp":{},"443/udp":{},"8080/tcp":{}}',
		);
		expect(JSON.stringify(portBindings)).toBe(
			JSON.stringify({
				"80/tcp": [{ HostPort: "80", HostIp: TRAEFIK_BIND_IP }],
				"443/tcp": [{ HostPort: "443", HostIp: TRAEFIK_BIND_IP }],
				"443/udp": [{ HostPort: "443", HostIp: TRAEFIK_BIND_IP }],
				"8080/tcp": [{ HostPort: "8080", HostIp: TRAEFIK_BIND_IP }],
			}),
		);
	});

	it("a custom host port for the dashboard replaces 8080 as before", () => {
		const { portBindings } = buildStandalonePortBindings([
			{ targetPort: 8080, publishedPort: 9000, protocol: "tcp" },
		]);

		expect(portBindings["8080/tcp"]).toEqual([bind("9000")]);
	});

	it("an extra port on target 80 keeps the built-in 80 binding", () => {
		const { portBindings } = buildStandalonePortBindings([
			{ targetPort: 80, publishedPort: 8085, protocol: "tcp" },
		]);

		expect(portBindings["80/tcp"]).toEqual([bind("80"), bind("8085")]);
	});
});
