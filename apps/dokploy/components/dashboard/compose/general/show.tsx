import { extractComposeImages } from "@dokploy/server/services/build-origin-shared";
import {
	GithubActionsAdvanced,
	GithubActionsPanel,
} from "@/components/shared/github-actions-panel";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ComposeActions, ComposeRebuildAction } from "./actions";
import { ShowProviderFormCompose } from "./generic/show";

interface Props {
	composeId: string;
}

export const ShowGeneralCompose = ({ composeId }: Props) => {
	const { data } = api.compose.one.useQuery(
		{ composeId },
		{
			enabled: !!composeId,
		},
	);
	// Built in GitHub Actions: Dokploy only pulls and starts the image (T-12424).
	const isGithubActions = data?.buildOrigin === "github-actions";

	return (
		<>
			{isGithubActions && (
				<GithubActionsPanel
					images={extractComposeImages(data?.composeFile)}
					buildRunUrl={data?.buildRunUrl}
					buildRepository={data?.buildRepository}
					buildCommitSha={data?.buildCommitSha}
					buildEnvironment={data?.buildEnvironment}
					buildRunId={data?.buildRunId}
					buildDeployedAt={data?.buildDeployedAt}
					buildRolledBack={data?.buildRolledBack}
				/>
			)}
			<Card className="bg-background">
				<CardHeader>
					<div className="flex flex-row gap-2 justify-between flex-wrap">
						<CardTitle className="text-xl">Deploy Settings</CardTitle>
						<Badge>
							{data?.composeType === "docker-compose" ? "Compose" : "Stack"}
						</Badge>
					</div>

					<CardDescription>
						{isGithubActions
							? "Redeploy the image that is running now. New versions come from GitHub Actions."
							: "Create a compose file to deploy your compose"}
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4 flex-wrap">
					<ComposeActions composeId={composeId} />
				</CardContent>
			</Card>
			{isGithubActions ? (
				<GithubActionsAdvanced description="The compose file, where it comes from, and other source settings.">
					<div className="flex flex-wrap items-center gap-3">
						<ComposeRebuildAction composeId={composeId} />
					</div>
					<ShowProviderFormCompose composeId={composeId} />
				</GithubActionsAdvanced>
			) : (
				<ShowProviderFormCompose composeId={composeId} />
			)}
		</>
	);
};
