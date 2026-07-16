import { type ReactNode, useEffect, useState } from "react";

export interface DomainLike {
	host: string;
	https: boolean;
}

/**
 * Build an ordered, de-duplicated list of favicon candidate URLs from a
 * project's domains. https domains come first, then http; each yields a
 * `<scheme>://<host>/favicon.ico` URL. On an https dashboard, http candidates
 * simply fail to load (mixed content) and the caller cascades to the next one.
 */
export const getProjectFaviconUrls = (domains: DomainLike[]): string[] => {
	const seen = new Set<string>();
	const urls: string[] = [];
	const add = (list: DomainLike[]) => {
		for (const domain of list) {
			if (!domain?.host) continue;
			const url = `${domain.https ? "https" : "http"}://${domain.host}/favicon.ico`;
			if (seen.has(url)) continue;
			seen.add(url);
			urls.push(url);
		}
	};
	add(domains.filter((domain) => domain?.https));
	add(domains.filter((domain) => !domain?.https));
	return urls;
};

interface ProjectIconProps {
	logo?: string | null;
	faviconUrls?: string[];
	className?: string;
	fallback: ReactNode;
}

/**
 * Renders a project's icon. If an explicit logo is set it wins. Otherwise it
 * tries the project's domain favicons in order, advancing to the next
 * candidate whenever one fails to load, and falls back to `fallback` once all
 * candidates are exhausted (or there are none). No backend fetching or caching
 * layer — the browser cache is the cache.
 */
export const ProjectIcon = ({
	logo,
	faviconUrls = [],
	className,
	fallback,
}: ProjectIconProps) => {
	const [index, setIndex] = useState(0);
	const faviconKey = faviconUrls.join("|");

	useEffect(() => {
		setIndex(0);
	}, [faviconKey]);

	if (logo) {
		// biome-ignore lint/performance/noImgElement: user uploaded project icon
		return <img src={logo} alt="" className={className} />;
	}

	const current = faviconUrls[index];
	if (!current) {
		return <>{fallback}</>;
	}

	return (
		// biome-ignore lint/performance/noImgElement: domain favicon
		<img
			key={current}
			src={current}
			alt=""
			className={className}
			onError={() => setIndex((prev) => prev + 1)}
		/>
	);
};
