import { db } from "@dokploy/server/db";
import {
	addDomainToCompose,
	renderComposeWithDomains,
} from "@dokploy/server/utils/docker/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

// T-8260: a deploy reads the patch rows once. The compose guard and the render
// that follows it work from the rows the deploy already read, so a compose-file
// patch edited in between is not built unchecked. Without rows the table is
// read, as before.

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: () => true,
		readFileSync: () => "services:\n  web:\n    image: on-disk\n",
	};
});

const compose = {
	composeId: "compose-1",
	appName: "stack",
	serverId: null,
	composeType: "docker-compose",
	sourceType: "git",
	composePath: "docker-compose.yml",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
} as any;

const patchRow = (image: string, extra: Record<string, unknown> = {}) => ({
	patchId: `patch-${image}`,
	type: "update",
	filePath: "docker-compose.yml",
	content: `services:\n  web:\n    image: ${image}\n`,
	enabled: true,
	...extra,
});

const findMany = vi.mocked(db.query.patch.findMany);
const imageOf = (spec: Awaited<ReturnType<typeof addDomainToCompose>>) =>
	(spec?.services?.web as { image?: string } | undefined)?.image;

beforeEach(() => {
	findMany.mockReset();
	findMany.mockResolvedValue([]);
});

describe("the compose file patch comes from the rows the deploy read", () => {
	it("renders the passed rows without reading the table", async () => {
		// The table has moved on since the deploy read its rows.
		findMany.mockResolvedValue([patchRow("edited-later")] as never);

		const spec = await addDomainToCompose(compose, [], {
			patches: [patchRow("as-checked")] as never,
		});

		expect(imageOf(spec)).toBe("as-checked");
		expect(findMany).not.toHaveBeenCalled();
	});

	it("builds from the checked rows in the render a deploy stages", async () => {
		findMany.mockResolvedValue([patchRow("edited-later")] as never);

		const rendered = await renderComposeWithDomains(compose, [], {
			patches: [patchRow("as-checked")] as never,
		});

		expect(rendered).toHaveProperty("content");
		expect((rendered as { content: string }).content).toContain("as-checked");
		expect((rendered as { content: string }).content).not.toContain(
			"edited-later",
		);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("uses no compose file patch when the deploy read none, whatever the table holds", async () => {
		findMany.mockResolvedValue([patchRow("added-later")] as never);

		const spec = await addDomainToCompose(compose, [], { patches: [] });

		expect(imageOf(spec)).toBe("on-disk");
		expect(findMany).not.toHaveBeenCalled();
	});

	it("still ignores disabled and delete rows among the passed ones", async () => {
		const spec = await addDomainToCompose(compose, [], {
			patches: [
				patchRow("off", { enabled: false }),
				patchRow("gone", { type: "delete" }),
			] as never,
		});

		expect(imageOf(spec)).toBe("on-disk");
	});

	it("reads the table once when it is given no rows", async () => {
		findMany.mockResolvedValue([patchRow("from-table")] as never);

		const spec = await addDomainToCompose(compose, []);

		expect(imageOf(spec)).toBe("from-table");
		expect(findMany).toHaveBeenCalledTimes(1);
	});
});
