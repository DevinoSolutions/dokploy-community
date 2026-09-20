/**
 * Columns of the owning unit that build-policy listings expose.
 *
 * The `application` table has 100+ columns. A relational
 * `with: { application: true }` packs every column into a single
 * json_build_array(...) call, and Postgres rejects any function call past 100
 * arguments ("cannot pass more than 100 arguments to a function", SQLSTATE
 * 54023), so the un-projected select fails on every instance. Keep this
 * projection to the fields the settings UI reads; the guard test in
 * apps/dokploy/__test__/db/relational-query-args-build-policy.test.ts mirrors
 * the exact query shapes.
 */
export const buildPolicyUnitProjection = {
	application: {
		columns: { applicationId: true, name: true, appName: true },
	},
	compose: {
		columns: { composeId: true, name: true, appName: true },
	},
} as const;
