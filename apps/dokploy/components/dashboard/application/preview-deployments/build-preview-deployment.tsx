import { GitPullRequest, Loader2, RocketIcon, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GithubIcon, GitlabIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

interface Props {
	applicationId?: string;
	composeId?: string;
	children: React.ReactNode;
}

interface ChangeRequest {
	id: number | string;
	number: number;
	title: string;
	html_url: string;
	branch: string;
	baseBranch?: string;
	draft?: boolean;
}

export const BuildPreviewDeployment = ({
	applicationId,
	composeId,
	children,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [selected, setSelected] = useState<ChangeRequest | null>(null);
	const [search, setSearch] = useState("");

	const { data: application } = api.application.one.useQuery(
		{ applicationId: applicationId || "" },
		{ enabled: !!applicationId },
	);
	const { data: compose } = api.compose.one.useQuery(
		{ composeId: composeId || "" },
		{ enabled: !!composeId },
	);

	const data = application || compose;
	const isGitlab = data?.sourceType === "gitlab";
	const changeRequestLabel = isGitlab ? "Merge Request" : "Pull Request";
	const owner = isGitlab ? data?.gitlabOwner || data?.owner : data?.owner;
	const repo = isGitlab
		? data?.gitlabRepository || data?.repository
		: data?.repository;

	const { data: githubPullRequests, isFetching: isFetchingGithub } =
		api.github.getGithubPullRequests.useQuery(
			{
				owner: owner || "",
				repo: repo || "",
				githubId: data?.githubId || "",
			},
			{
				enabled:
					!!isOpen &&
					!!data &&
					data.sourceType === "github" &&
					!!owner &&
					!!repo,
			},
		);

	const { data: gitlabMergeRequests, isFetching: isFetchingGitlab } =
		api.gitlab.getGitlabMergeRequests.useQuery(
			{
				id: data?.gitlabProjectId || 0,
				owner: data?.gitlabOwner || "",
				repo: data?.gitlabRepository || "",
				gitlabId: data?.gitlabId || "",
			},
			{
				enabled:
					!!isOpen &&
					!!data &&
					data.sourceType === "gitlab" &&
					!!data.gitlabId &&
					!!data.gitlabProjectId,
			},
		);

	const changeRequests = (
		isGitlab ? gitlabMergeRequests : githubPullRequests
	) as ChangeRequest[] | undefined;
	const isFetching = isFetchingGithub || isFetchingGitlab;

	const filtered = changeRequests?.filter((cr) => {
		if (!search) return true;
		const q = search.toLowerCase();
		return (
			String(cr.number).includes(q) ||
			cr.title.toLowerCase().includes(q) ||
			cr.branch.toLowerCase().includes(q)
		);
	});

	const { mutateAsync: createPreviewDeployment, isPending } =
		api.previewDeployment.create.useMutation();

	const handleBuild = async () => {
		if (!selected) return;
		try {
			await createPreviewDeployment({
				applicationId,
				composeId,
				branch: selected.branch,
				pullRequestId: String(selected.id),
				pullRequestNumber: String(selected.number),
				pullRequestTitle: selected.title,
				pullRequestURL: selected.html_url,
			});
			toast.success(
				`${changeRequestLabel} #${selected.number} preview deployment started`,
			);
			setIsOpen(false);
			setSelected(null);
			setSearch("");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Error building preview deployment",
			);
		}
	};

	useEffect(() => {
		if (!isOpen) {
			setSelected(null);
			setSearch("");
		}
	}, [isOpen]);

	const ChangeRequestIcon = isGitlab ? GitlabIcon : GithubIcon;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg w-full">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitPullRequest className="size-5" />
						Build {changeRequestLabel}
					</DialogTitle>
					<DialogDescription>
						Select an open {changeRequestLabel.toLowerCase()} from the
						repository to create and deploy a preview deployment.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					{!data?.isPreviewDeploymentsActive && (
						<AlertBlock type="warning">
							Preview deployments are disabled for this resource.
						</AlertBlock>
					)}
					{owner && repo && (
						<div className="text-sm text-muted-foreground">
							{owner}/{repo}
						</div>
					)}
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<Input
							placeholder={`Search ${changeRequestLabel.toLowerCase()}s...`}
							className="pl-9"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					{isFetching ? (
						<div className="flex flex-col items-center justify-center gap-3 min-h-[25vh]">
							<Loader2 className="size-6 text-muted-foreground animate-spin" />
							<span className="text-sm text-muted-foreground">
								Loading open {changeRequestLabel.toLowerCase()}s...
							</span>
						</div>
					) : !filtered?.length ? (
						<div className="flex flex-col items-center justify-center gap-3 min-h-[25vh]">
							<ChangeRequestIcon className="size-8 text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								No open {changeRequestLabel.toLowerCase()}s found
							</span>
						</div>
					) : (
						<Select
							value={selected ? String(selected.number) : undefined}
							onValueChange={(value) => {
								const cr = filtered?.find(
									(item) => String(item.number) === value,
								);
								setSelected(cr || null);
							}}
						>
							<SelectTrigger className="w-full">
								<SelectValue
									placeholder={`Select an open ${changeRequestLabel.toLowerCase()}`}
								/>
							</SelectTrigger>
							<SelectContent>
								{filtered?.map((cr) => (
									<SelectItem
										key={String(cr.id)}
										value={String(cr.number)}
										className="flex flex-col items-start gap-1"
									>
										<span className="flex items-center gap-2 font-medium">
											#{cr.number} {cr.draft && "(draft)"}
										</span>
										<span className="line-clamp-1 text-xs text-muted-foreground">
											{cr.title}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					{selected && (
						<div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
							<div className="font-medium">
								#{selected.number} {selected.title}
							</div>
							<div className="text-muted-foreground">
								Branch: <span className="font-mono">{selected.branch}</span>
							</div>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={() => setIsOpen(false)}>
						Cancel
					</Button>
					<Button
						isLoading={isPending}
						disabled={!selected || !data?.isPreviewDeploymentsActive}
						onClick={handleBuild}
					>
						<RocketIcon className="size-4" />
						Build preview
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
