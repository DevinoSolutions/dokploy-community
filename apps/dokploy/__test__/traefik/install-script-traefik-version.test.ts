import { readFileSync } from "node:fs";
import path from "node:path";
import { TRAEFIK_VERSION } from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

// install.sh is fetched on its own, so it can't import the pin.
const installScript = readFileSync(
	path.resolve(__dirname, "../../../../install.sh"),
	"utf8",
);

describe("install.sh", () => {
	it("starts the Traefik version the server pins", () => {
		const tags = [...installScript.matchAll(/traefik:v([0-9][^\s"']*)/g)].map(
			(match) => match[1],
		);

		expect(tags.length).toBeGreaterThan(0);
		expect(new Set(tags)).toEqual(new Set([TRAEFIK_VERSION]));
	});
});
