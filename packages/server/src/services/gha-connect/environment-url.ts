/**
 * The link GitHub shows next to a successful deployment (`environment_url`).
 * Pure: the caller reads the service's domains.
 */

export interface DomainLike {
	host: string;
	https: boolean;
	path: string | null;
	/** Domains created for previews or other purposes are skipped by the caller. */
	enabled?: boolean;
}

const HOST =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The first domain served over https, else the first domain; undefined without a usable host. */
export const pickEnvironmentUrl = (
	domains: readonly DomainLike[],
): string | undefined => {
	const usable = domains.filter(
		(d) => d.enabled !== false && HOST.test(d.host.trim()),
	);
	const chosen = usable.find((d) => d.https) ?? usable[0];
	if (!chosen) return undefined;
	const path =
		chosen.path &&
		chosen.path !== "/" &&
		/^\/[A-Za-z0-9._~\-/]*$/.test(chosen.path)
			? chosen.path
			: "";
	return `${chosen.https ? "https" : "http"}://${chosen.host.trim().toLowerCase()}${path}`;
};
