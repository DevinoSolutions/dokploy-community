import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `user.sendInvitation` mails an invitation link through one of the
 * organization's email providers (SMTP, Resend, Sendly). Both ids come from the
 * client, so both must belong to the caller's active organization: another
 * organization's provider is never used to send, and another organization's
 * invitation (its email and token) is never mailed.
 */

const mocks = vi.hoisted(() => ({
	notification: null as Record<string, unknown> | null,
	invitations: [] as Record<string, unknown>[],
	sentEmail: vi.fn(async () => {}),
	sentResend: vi.fn(async () => {}),
	sentSendly: vi.fn(async () => {}),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkPermission: vi.fn(async () => {}),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		findNotificationById: vi.fn(async () => mocks.notification),
		findOrganizationById: vi.fn(async () => ({ name: "Acme" })),
		getDokployUrl: vi.fn(async () => "https://dokploy.test"),
		renderInvitationEmail: vi.fn(async () => "<p>invite</p>"),
		sendEmailNotification: mocks.sentEmail,
		sendResendNotification: mocks.sentResend,
		sendSendlyNotification: mocks.sentSendly,
	};
});

// The values a drizzle condition binds, e.g. the id in eq(column, id).
const boundValues = (node: unknown): unknown[] => {
	if (!node || typeof node !== "object") return [];
	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) return chunks.flatMap(boundValues);
	return "value" in node && !Array.isArray((node as { value: unknown }).value)
		? [(node as { value: unknown }).value]
		: [];
};

const { db } = await import("@dokploy/server/db");
const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const notificationOf = (organizationId: string, provider: string) => ({
	notificationId: "n-1",
	organizationId,
	email: null,
	resend: null,
	sendly: null,
	[provider]: { toAddresses: [], fromAddress: "noreply@example.com" },
});

const nothingSent = () => {
	expect(mocks.sentEmail).not.toHaveBeenCalled();
	expect(mocks.sentResend).not.toHaveBeenCalled();
	expect(mocks.sentSendly).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.invitations = [
		{ id: "inv-own", organizationId: "org-1", email: "new@acme.test" },
		{ id: "inv-foreign", organizationId: "org-2", email: "victim@other.test" },
	];
	// Applies the organization filter only if the query carries one, so a query
	// that looks the invitation up by id alone returns another organization's row.
	vi.spyOn(db.query.invitation, "findFirst").mockImplementation(
		(async (config?: { where?: unknown }) => {
			const bound = boundValues(config?.where);
			const organizations = mocks.invitations.map((row) => row.organizationId);
			const filtersByOrganization = bound.some((value) =>
				organizations.includes(value),
			);
			return mocks.invitations.find(
				(row) =>
					bound.includes(row.id) &&
					(!filtersByOrganization || bound.includes(row.organizationId)),
			);
		}) as never,
	);
});

describe.each([
	["email", () => mocks.sentEmail],
	["resend", () => mocks.sentResend],
	["sendly", () => mocks.sentSendly],
])("user.sendInvitation through the %s provider", (provider, sender) => {
	it("sends the caller's own invitation through the caller's own provider", async () => {
		mocks.notification = notificationOf("org-1", provider);

		const link = await caller.user.sendInvitation({
			invitationId: "inv-own",
			notificationId: "n-1",
		});

		expect(link).toBe("https://dokploy.test/invitation?token=inv-own");
		expect(sender()).toHaveBeenCalledTimes(1);
		expect(sender()).toHaveBeenCalledWith(
			expect.objectContaining({ toAddresses: ["new@acme.test"] }),
			expect.stringContaining("Acme"),
			"<p>invite</p>",
		);
	});

	it("refuses another organization's provider and sends nothing", async () => {
		mocks.notification = notificationOf("org-2", provider);

		await expect(
			caller.user.sendInvitation({
				invitationId: "inv-own",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		nothingSent();
	});

	it("refuses another organization's invitation and sends nothing", async () => {
		mocks.notification = notificationOf("org-1", provider);

		await expect(
			caller.user.sendInvitation({
				invitationId: "inv-foreign",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		nothingSent();
	});

	it("refuses both foreign at once", async () => {
		mocks.notification = notificationOf("org-2", provider);

		await expect(
			caller.user.sendInvitation({
				invitationId: "inv-foreign",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		nothingSent();
	});
});

describe("user.sendInvitation", () => {
	it("does not mail an empty address for an invitation that does not exist", async () => {
		mocks.notification = notificationOf("org-1", "email");

		await expect(
			caller.user.sendInvitation({
				invitationId: "inv-missing",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		nothingSent();
	});

	it("still rejects an own notification that is not an email provider", async () => {
		mocks.notification = notificationOf("org-1", "slack");

		await expect(
			caller.user.sendInvitation({
				invitationId: "inv-own",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Email provider not found",
		});
		nothingSent();
	});
});
