interface CancelledByEntry {
	actorType: "user" | "api_key" | "system";
	actorEmail: string | null;
	apiKeyName: string | null;
	apiKeyShortId: string | null;
}

/**
 * The line a cancelled deployment shows under its status: who stopped it.
 * An API key is named by its name, or by the start of its id when it has none
 * (or has been deleted), next to the user it belongs to.
 */
export const describeCancelledBy = (entry: CancelledByEntry): string => {
	if (entry.actorType === "system") return "Cancelled by system";
	const user = entry.actorEmail?.trim() || null;
	if (entry.actorType === "api_key") {
		const key = entry.apiKeyName?.trim() || entry.apiKeyShortId;
		const label = key ? `API key ${key}` : "an API key";
		return user ? `Cancelled by ${label} (${user})` : `Cancelled by ${label}`;
	}
	return `Cancelled by ${user ?? "a user"}`;
};
