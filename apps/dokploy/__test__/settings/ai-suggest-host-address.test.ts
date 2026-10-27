import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The address `suggestVariants` is given is what ends up in the model's
 * prompt, so the prompt is where a host address that was not meant for the
 * organization would show. With no address the prompt asks for no host built
 * from it.
 */
const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	findFirst: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	generateText: mocks.generateText,
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: { query: { ai: { findFirst: mocks.findFirst } } },
}));

vi.mock("@dokploy/server/utils/ai/select-ai-provider", () => ({
	selectAIProvider: () => () => "model",
}));

const { suggestVariants } = await import("@dokploy/server/services/ai");

const HOST_IP = "198.51.100.7";
const DASHED_IP = "198-51-100-7";

const suggest = async (hostIp: string, serverId?: string) => {
	await suggestVariants({
		organizationId: "org-1",
		aiId: "ai-1",
		input: "a wordpress site",
		serverId,
		hostIp,
	});
	return mocks.generateText.mock.calls[0]?.[0]?.prompt as string;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NODE_ENV", "test");
	mocks.findFirst.mockResolvedValue({
		aiId: "ai-1",
		organizationId: "org-1",
		isEnabled: true,
		model: "gpt",
	});
	mocks.generateText.mockResolvedValue({
		output: { suggestions: [{ dockerCompose: "services: {}" }] },
	});
});

describe("suggestVariants prompt", () => {
	it("builds the sslip.io host from the address it is given", async () => {
		const prompt = await suggest(HOST_IP);

		expect(prompt).toContain(`-${DASHED_IP}.sslip.io`);
		expect(prompt).not.toContain(HOST_IP);
	});

	it("asks for no sslip.io host and no address without one", async () => {
		const prompt = await suggest("");

		expect(prompt).not.toContain(".sslip.io");
		expect(prompt).not.toMatch(/\d+-\d+-\d+-\d+/);
		expect(prompt).not.toContain("-.");
		expect(prompt).toContain("empty domains array");
	});

	it("uses the loopback address in development when there is no server", async () => {
		vi.stubEnv("NODE_ENV", "development");

		const prompt = await suggest("");

		expect(prompt).toContain("-127-0-0-1.sslip.io");
	});

	it("keeps the given address in development when there is a server", async () => {
		vi.stubEnv("NODE_ENV", "development");

		const prompt = await suggest(HOST_IP, "srv-1");

		expect(prompt).toContain(`-${DASHED_IP}.sslip.io`);
		expect(prompt).not.toContain("127-0-0-1");
	});
});
