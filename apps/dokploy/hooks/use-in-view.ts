import { useEffect, useRef, useState } from "react";

/**
 * `true` once the element has been on screen (and stays `true`), so work tied
 * to a row of a long list can wait until the row is actually seen. Without
 * `IntersectionObserver` (old browsers, tests) the element counts as seen.
 */
export const useInView = <T extends Element>() => {
	const ref = useRef<T | null>(null);
	const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");

	useEffect(() => {
		const element = ref.current;
		if (seen || !element) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setSeen(true);
				observer.disconnect();
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [seen]);

	return [ref, seen] as const;
};
