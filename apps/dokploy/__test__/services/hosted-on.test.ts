import { describe, expect, test } from "vitest";
import { describeHostedOn } from "@/components/dashboard/deployments/hosted-on";

const prod = { name: "prod-1", serverType: "deploy" };
const builder = { name: "builder-1", serverType: "build" };

describe("describeHostedOn (T-13981)", () => {
	test("a GitHub Actions row on a remote server has no build line", () => {
		expect(
			describeHostedOn({
				buildOrigin: "github-actions",
				application: { server: prod, buildServer: builder },
			}),
		).toEqual({ hostName: "prod-1", hostType: "deploy", builtOn: null });
	});

	test("a Dokploy-built row names a different build server", () => {
		expect(
			describeHostedOn({
				buildOrigin: "dokploy",
				server: prod,
				buildServer: builder,
			}),
		).toEqual({
			hostName: "prod-1",
			hostType: "deploy",
			builtOn: { name: "builder-1", type: "build" },
		});
	});

	test("no server means the Dokploy host", () => {
		expect(describeHostedOn({ buildOrigin: "dokploy" })).toEqual({
			hostName: "Dokploy",
			hostType: null,
			builtOn: null,
		});
	});

	test("a build server equal to the host adds nothing", () => {
		expect(
			describeHostedOn({
				buildOrigin: "dokploy",
				compose: { server: prod },
				application: null,
				buildServer: { name: "prod-1", serverType: "deploy" },
			}),
		).toMatchObject({ hostName: "prod-1", builtOn: null });
	});
});
