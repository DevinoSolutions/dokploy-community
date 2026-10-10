/** Masks a stored API key down to its last four characters. */
export const maskApiKey = (apiKey: string) =>
	apiKey.length > 4 ? `••••${apiKey.slice(-4)}` : "••••";
