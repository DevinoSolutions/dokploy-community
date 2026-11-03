import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deleting a service must remove its GitHub Actions connection and the #577
 * watch it owns, in the transaction that deletes the service. The router and
 * service files are large and need a whole server to run, so this pins the
 * wiring in the source: the connection removal sits inside the same
 * `db.transaction` as the delete, for each path that deletes services.
 */

const read = (relative: string) =>
	fs.readFileSync(path.resolve(__dirname, "../../", relative), "utf8");

const transactionAround = (source: string, deleteCall: string) => {
	const at = source.indexOf(deleteCall);
	expect(at, `${deleteCall} is present`).toBeGreaterThan(-1);
	const start = source.lastIndexOf("db.transaction(", at);
	expect(start, "the delete is inside a transaction").toBeGreaterThan(-1);
	// The transaction body ends at the first line that closes it at the same indent.
	const rest = source.slice(start);
	const end = rest.search(/\n\t*\}\);\n/);
	return rest.slice(0, end);
};

describe("service deletion removes the GitHub Actions connection and its watch", () => {
	it("application.delete", () => {
		const body = transactionAround(
			read("server/api/routers/application.ts"),
			".delete(applications)",
		);
		expect(body).toContain("removeGhaConnectionsForServices");
		expect(body).toContain('serviceType: "application"');
	});

	it("compose.delete", () => {
		const body = transactionAround(
			read("server/api/routers/compose.ts"),
			".delete(composeTable)",
		);
		expect(body).toContain("removeGhaConnectionsForServices");
		expect(body).toContain('serviceType: "compose"');
	});

	it("project removal (the cascade drops every service of the project)", () => {
		const body = transactionAround(
			read("../../packages/server/src/services/project.ts"),
			".delete(projects)",
		);
		expect(body).toContain("removeGhaConnectionsForServices");
		expect(body).toContain("applicationId");
		expect(body).toContain("composeId");
	});
});
