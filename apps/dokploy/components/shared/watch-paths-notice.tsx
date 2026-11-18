import { watchPathsNotice } from "@dokploy/server/utils/watch-paths/validate-watch-paths";
import { AlertBlock } from "@/components/shared/alert-block";

/**
 * Shown on a watch-paths field when the list holds a pattern the validator
 * refuses (picomatch GHSA-fc5q-39xc-vjpf). Deploys ignore such a list and
 * deploy on every push, so a server log line is not the only signal.
 */
export const WatchPathsNotice = ({
	paths,
}: {
	paths?: readonly string[] | null;
}) => {
	const notice = watchPathsNotice(paths);
	if (!notice) return null;
	return (
		<AlertBlock
			type="warning"
			className="mb-2"
			data-testid="watch-paths-notice"
		>
			{notice}
		</AlertBlock>
	);
};
