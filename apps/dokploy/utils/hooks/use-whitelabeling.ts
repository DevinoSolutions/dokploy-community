// ponytail: whitelabeling removed (proprietary). Stubs kept because 16+ pages import these hooks.
type WhitelabelConfig = Record<string, string | undefined>;

export function useWhitelabeling() {
	return { config: null as WhitelabelConfig | null };
}

export function useWhitelabelingPublic() {
	return { config: null as WhitelabelConfig | null };
}
