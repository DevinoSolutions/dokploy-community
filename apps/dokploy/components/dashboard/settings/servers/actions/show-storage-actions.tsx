import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/utils/api";

/** Builds are running on the server: show the server's own explanation as-is. */
const toastCleanupError = (fallback: string, error: unknown) => {
	const data = (error as { data?: { code?: string } } | null)?.data;
	if (data?.code === "PRECONDITION_FAILED" && error instanceof Error) {
		toast.error(error.message);
		return;
	}
	toast.error(fallback);
};

interface Props {
	serverId?: string;
}
export const ShowStorageActions = ({ serverId }: Props) => {
	const { mutateAsync: cleanAll, isPending: cleanAllIsLoading } =
		api.settings.cleanAll.useMutation();

	const {
		mutateAsync: cleanDockerBuilder,
		isPending: cleanDockerBuilderIsPending,
	} = api.settings.cleanDockerBuilder.useMutation();

	const { mutateAsync: cleanMonitoring } =
		api.settings.cleanMonitoring.useMutation();
	const {
		mutateAsync: cleanUnusedImages,
		isPending: cleanUnusedImagesIsPending,
	} = api.settings.cleanUnusedImages.useMutation();

	const {
		mutateAsync: cleanUnusedVolumes,
		isPending: cleanUnusedVolumesIsPending,
	} = api.settings.cleanUnusedVolumes.useMutation();

	const {
		mutateAsync: cleanStoppedContainers,
		isPending: cleanStoppedContainersIsPending,
	} = api.settings.cleanStoppedContainers.useMutation();

	const { mutateAsync: cleanPatchRepos, isPending: cleanPatchReposIsLoading } =
		api.patch.cleanPatchRepos.useMutation();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				asChild
				disabled={
					cleanAllIsLoading ||
					cleanDockerBuilderIsPending ||
					cleanUnusedImagesIsPending ||
					cleanUnusedVolumesIsPending ||
					cleanStoppedContainersIsPending ||
					cleanPatchReposIsLoading
				}
			>
				<Button
					isLoading={
						cleanAllIsLoading ||
						cleanDockerBuilderIsPending ||
						cleanUnusedImagesIsPending ||
						cleanUnusedVolumesIsPending ||
						cleanStoppedContainersIsPending ||
						cleanPatchReposIsLoading
					}
					variant="outline"
				>
					Space
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-64" align="start">
				<DropdownMenuLabel>Actions</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanUnusedImages({
								serverId: serverId,
							})
								.then(async () => {
									toast.success("Cleaned images");
								})
								.catch(() => {
									toast.error("Error cleaning images");
								});
						}}
					>
						<span>Clean unused images</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanUnusedVolumes({
								serverId: serverId,
							})
								.then(async () => {
									toast.success("Cleaned volumes");
								})
								.catch(() => {
									toast.error("Error cleaning volumes");
								});
						}}
					>
						<span>Clean unused volumes</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanStoppedContainers({
								serverId: serverId,
							})
								.then(async () => {
									toast.success("Stopped containers cleaned");
								})
								.catch(() => {
									toast.error("Error cleaning stopped containers");
								});
						}}
					>
						<span>Clean stopped containers</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanPatchRepos({
								serverId: serverId,
							})
								.then(async () => {
									toast.success("Cleaned Patch Caches");
								})
								.catch(() => {
									toast.error("Error cleaning Patch Caches");
								});
						}}
					>
						<span>Clean Patch Caches</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanDockerBuilder({
								serverId: serverId,
							})
								.then(async () => {
									toast.success("Cleaned Docker Builder");
								})
								.catch((error) => {
									toastCleanupError("Error cleaning Docker Builder", error);
								});
						}}
					>
						<span>Clean Docker Builder cache</span>
					</DropdownMenuItem>
					<p className="px-2 pb-1.5 text-xs text-muted-foreground">
						Blocked while builds run on this server.
					</p>
					{!serverId && (
						<DropdownMenuItem
							className="w-full cursor-pointer"
							onClick={async () => {
								await cleanMonitoring()
									.then(async () => {
										toast.success("Cleaned Monitoring");
									})
									.catch(() => {
										toast.error("Error cleaning Monitoring");
									});
							}}
						>
							<span>Clean Monitoring</span>
						</DropdownMenuItem>
					)}

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={async () => {
							await cleanAll({
								serverId: serverId,
							})
								.then(async (result) => {
									if (result?.skipped?.length) {
										toast.warning(result.message);
										return;
									}
									toast.success("Cleaning in progress... Please wait");
								})
								.catch((error) => {
									toastCleanupError("Error cleaning all", error);
								});
						}}
					>
						<span>Clean all</span>
					</DropdownMenuItem>
					<p className="px-2 pb-1.5 text-xs text-muted-foreground">
						Skips the image and builder cleanup while builds run on this server.
					</p>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
