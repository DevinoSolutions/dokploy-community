import type { ChangeRequest } from "@dokploy/server";
import { GitPullRequest, Loader2, RocketIcon, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

interface PreviewResource {
	applicationId?: string;
	composeId?: string;
	sourceType: string;
	isPreviewDeploymentsActive: boolean | null;
	owner: string | null;
	repository: string | null;
	githubId: string | null;
	gitlabId: string | null;
	gitlabOwner: string | null;
	gitlabRepository: string | null;
	gitlabProjectId: number | null;
}

interface Props {
	resource: PreviewResource;
	children: React.ReactNode;
}

export const BuildPreviewDeployment = ({ resource, children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [selected, setSelected] = useState<ChangeRequest | null>(null);
	const [search, setSearch] = useState("");

	const isGitlab = resource.sourceType === "gitlab";
	const changeRequestLabel = isGitlab ? "Merge Request" : "Pull Request";
	const changeRequestLabelPlural = `${changeRequestLabel.toLowerCase()}s`;

	const owner = isGitlab
		? (resource.gitlabOwner ?? resource.owner)
		: resource.owner;
	const repo = isGitlab
		? (resource.gitlabRepository ?? resource.repository)
		: resource.repository;

	const { data: githubPullRequests, isFetching: isFetchingGithub } =
		api.github.getGithubPullRequests.useQuery(
			{
				owner: resource.owner ?? "",
				repo: resource.repository ?? "",
				githubId: resource.githubId ?? "",
			},
			{
				enabled:
					isOpen &&
					!isGitlab &&
					!!resource.owner &&
					!!resource.repository &&
					!!resource.githubId,
			},
		);

	const { data: gitlabMergeRequests, isFetching: isFetchingGitlab } =
		api.gitlab.getGitlabMergeRequests.useQuery(
			{
				id: resource.gitlabProjectId ?? 0,
				owner: resource.gitlabOwner ?? "",
				repo: resource.gitlabRepository ?? "",
				gitlabId: resource.gitlabId ?? "",
			},
			{
				enabled:
					isOpen &&
					isGitlab &&
					!!resource.gitlabId &&
					!!resource.gitlabProjectId &&
					!!resource.gitlabOwner &&
					!!resource.gitlabRepository,
			},
		);

	const changeRequests = isGitlab ? gitlabMergeRequests : githubPullRequests;
	const isFetching = isFetchingGithub || isFetchingGitlab;

	const filtered = useMemo(() => {
		if (!changeRequests) return undefined;
		if (!search) return changeRequests;
		const q = search.toLowerCase();
		return changeRequests.filter(
			(cr) =>
				String(cr.number).includes(q) ||
				cr.title.toLowerCase().includes(q) ||
				cr.branch.toLowerCase().includes(q),
		);
	}, [changeRequests, search]);

	const { mutateAsync: createPreviewDeployment, isPending } =
		api.previewDeployment.create.useMutation();

	const handleBuild = async () => {
		if (!selected) return;
		try {
			await createPreviewDeployment({
				applicationId: resource.applicationId,
				composeId: resource.composeId,
				branch: selected.branch,
				pullRequestId: String(selected.id),
				pullRequestNumber: String(selected.number),
				pullRequestTitle: selected.title,
				pullRequestURL: selected.url,
			});
			toast.success(
				`${changeRequestLabel} #${selected.number} preview deployment started`,
			);
			setIsOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Error building preview deployment",
			);
		}
	};

	const reset = () => {
		setSelected(null);
		setSearch("");
	};

	useEffect(() => {
		if (!isOpen) reset();
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
					{!resource.isPreviewDeploymentsActive && (
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
							placeholder={`Search ${changeRequestLabelPlural}...`}
							className="pl-9"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					{isFetching ? (
						<div className="flex flex-col items-center justify-center gap-3 min-h-[25vh]">
							<Loader2 className="size-6 text-muted-foreground animate-spin" />
							<span className="text-sm text-muted-foreground">
								Loading open {changeRequestLabelPlural}...
							</span>
						</div>
					) : !filtered?.length ? (
						<div className="flex flex-col items-center justify-center gap-3 min-h-[25vh]">
							<ChangeRequestIcon className="size-8 text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								No open {changeRequestLabelPlural} found
							</span>
						</div>
					) : (
						<Select
							value={selected ? String(selected.number) : undefined}
							onValueChange={(value) =>
								setSelected(
									filtered.find((cr) => String(cr.number) === value) ?? null,
								)
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue
									placeholder={`Select an open ${changeRequestLabel.toLowerCase()}`}
								/>
							</SelectTrigger>
							<SelectContent>
								{filtered.map((cr) => (
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
						disabled={!selected || !resource.isPreviewDeploymentsActive}
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
