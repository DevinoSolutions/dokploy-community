import {
	createScheduleSchema,
	schedules,
	updateScheduleSchema,
} from "@dokploy/server/db/schema/schedule";
import { isPlainAppName } from "@dokploy/server/db/schema/utils";
import { describe, expect, it } from "vitest";

const base = {
	name: "Nightly cleanup",
	cronExpression: "0 0 * * *",
	command: "echo hi",
	shellType: "bash",
	enabled: true,
} as const;

describe("schedule app name", () => {
	it.each(["application", "compose", "server", "dokploy-server"] as const)(
		"ignores a client-supplied app name for %s schedules",
		(scheduleType) => {
			const input = {
				...base,
				scheduleType,
				appName: "x$(touch pwned)",
				script: scheduleType.includes("server") ? "echo hi" : undefined,
			};
			const created = createScheduleSchema.safeParse(input);
			expect(created.success).toBe(true);
			expect(created.data).not.toHaveProperty("appName");

			const updated = updateScheduleSchema.safeParse({
				...input,
				scheduleId: "sch-1",
				appName: "../../etc",
			});
			expect(updated.success).toBe(true);
			expect(updated.data).not.toHaveProperty("appName");
		},
	);

	it("generates a plain directory name for every schedule on the server", () => {
		const generate = schedules.appName.defaultFn;
		expect(generate).toBeTypeOf("function");
		for (let index = 0; index < 500; index++) {
			const appName = generate?.() as string;
			expect(appName).toMatch(/^schedule-/);
			expect(isPlainAppName(appName)).toBe(true);
		}
	});

	it("tells plain names from ones that are not", () => {
		for (const name of [
			"schedule-hack-open-source-bus-AbC123",
			"my_app.v1",
			"a",
		]) {
			expect(isPlainAppName(name)).toBe(true);
		}
		for (const name of [
			"",
			".",
			"..",
			"...",
			"a/b",
			"../x",
			"a b",
			"x$(id)",
			"x`id`",
			"x;y",
			"a\nb",
			'a"b',
		]) {
			expect(isPlainAppName(name)).toBe(false);
		}
	});
});
