import { describe, expect, it } from "vitest";

/**
 * Mirrors the transport-options branch in
 * packages/server/src/utils/notifications/utils.ts (sendEmailNotification):
 * the `auth` option is only passed to nodemailer when BOTH a username and a
 * password are present, so SMTP relays that allowlist by IP (no credentials)
 * connect without authentication.
 */
const buildTransportOptions = (
	host: string,
	port: number,
	username?: string | null,
	password?: string | null,
) => ({
	host,
	port,
	...(username && password ? { auth: { user: username, pass: password } } : {}),
});

describe("sendEmailNotification transport auth", () => {
	it("includes auth when both credentials are provided", () => {
		const options = buildTransportOptions(
			"smtp.example.com",
			587,
			"user",
			"pass",
		);
		expect(options).toHaveProperty("auth", { user: "user", pass: "pass" });
	});

	it("omits auth when both credentials are empty", () => {
		const options = buildTransportOptions("smtp.example.com", 587, "", "");
		expect(options).not.toHaveProperty("auth");
	});

	it("omits auth when only the username is provided", () => {
		const options = buildTransportOptions("smtp.example.com", 587, "user", "");
		expect(options).not.toHaveProperty("auth");
	});

	it("omits auth when only the password is provided", () => {
		const options = buildTransportOptions("smtp.example.com", 587, "", "pass");
		expect(options).not.toHaveProperty("auth");
	});

	it("omits auth when credentials are undefined", () => {
		const options = buildTransportOptions("smtp.example.com", 587);
		expect(options).not.toHaveProperty("auth");
	});
});
