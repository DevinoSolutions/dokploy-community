import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The DNS Providers page carries a DoDomain explainer card. Component tests
 * are not run in this repo (vitest only includes .test.ts), so the contract is
 * checked on the source: the card is wired into the page, says DoDomain is not
 * a provider, only reads whether it is configured, and links to the settings
 * page only for the roles that can open it.
 */
const read = (relative: string) =>
	fs.readFileSync(path.resolve(__dirname, "../../", relative), "utf8");

const card = read("components/dashboard/settings/dns/dodomain-dns-card.tsx");
const page = read("components/dashboard/settings/dns/show-dns-providers.tsx");
const integrationPage = read("pages/dashboard/settings/integrations.tsx");

describe("DoDomain card on the DNS Providers page", () => {
	it("is rendered by the page", () => {
		expect(page).toContain("<DoDomainDnsCard />");
	});

	it("explains that DoDomain is not a provider and where it is used", () => {
		expect(card).toContain("DoDomain is not a DNS provider");
		expect(card).toContain("a domain you do not");
		expect(card).toContain("their own registrar");
		expect(card).toContain("Domains tab");
		expect(card).toContain("checking its status automatically");
	});

	it("only reads whether it is configured, never the integration or its key", () => {
		expect(card).toContain("api.dodomain.configured.useQuery");
		expect(card).not.toContain("dodomain.one");
		expect(card).not.toMatch(/secretKey|secret key/i);
	});

	it("links to the integration settings only for roles that can open them", () => {
		// The same gate as the settings page and its sidebar entry.
		expect(integrationPage).toContain('user.role !== "owner" && user.role !== "admin"');
		expect(card).toContain('user?.role === "owner" || user?.role === "admin"');
		const link = card.indexOf("<Link");
		const gate = card.indexOf("canOpenSettings ?");
		expect(gate).toBeGreaterThan(-1);
		expect(link).toBeGreaterThan(gate);
		expect(card).toContain('"/dashboard/settings/integrations"');
		expect(card).toContain("An organization admin can");
	});

	it("is hidden on cloud, where the integration does not exist", () => {
		expect(card).toContain("if (isCloud) return null;");
	});

	it("reuses the logo and the Learn more link", () => {
		expect(card).toContain("<DoDomainMark");
		expect(card).toContain("INTEGRATION_LEARN_MORE_URLS.dodomain");
	});
});
