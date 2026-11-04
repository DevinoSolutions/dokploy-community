import { isGhaSourceType } from "@dokploy/server/services/gha-connect/provider";
import { GithubActionsAdvanced } from "@/components/shared/github-actions-panel";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ComposeActions } from "./actions";
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
	const isGhaProvider = isGhaSourceType(data?.sourceType);
	const isGithubActions =
		data?.buildOrigin === "github-actions" || isGhaProvider;

	return (
		<>
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
			{isGhaProvider ? (
				<ShowProviderFormCompose composeId={composeId} />
			) : isGithubActions ? (
				<GithubActionsAdvanced description="The compose file and where it comes from. Rebuild and autodeploy are hidden because GitHub Actions builds this service.">
					<ShowProviderFormCompose composeId={composeId} />
				</GithubActionsAdvanced>
			) : (
				<ShowProviderFormCompose composeId={composeId} />
			)}
		</>
	);
};
