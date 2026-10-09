import {
	isValidPreviewIdentifier,
	PREVIEW_IMAGE_PLACEHOLDER,
	resolvePreviewDockerImage,
} from "@dokploy/server/utils/preview-image";
import { Container, RocketIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
	previewDockerImage: string | null;
	isPreviewDeploymentsActive: boolean | null;
	children: React.ReactNode;
}

/**
 * Manual trigger for a preview of a Docker-image application. There is no
 * pull request to pick: the value typed here fills the image template's
 * placeholder and selects which image the preview pulls.
 */
export const BuildDockerImagePreview = ({
	applicationId,
	previewDockerImage,
	isPreviewDeploymentsActive,
	children,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [identifier, setIdentifier] = useState("");

	const { mutateAsync: createPreviewDeployment, isPending } =
		api.previewDeployment.create.useMutation();

	const trimmed = identifier.trim();
	const isValid = !!trimmed && isValidPreviewIdentifier(trimmed);

	const image = useMemo(() => {
		if (!isValid) return null;
		try {
			return resolvePreviewDockerImage(previewDockerImage, trimmed);
		} catch {
			return null;
		}
	}, [previewDockerImage, trimmed, isValid]);

	useEffect(() => {
		if (!isOpen) setIdentifier("");
	}, [isOpen]);

	const handleDeploy = async () => {
		if (!isValid) return;
		try {
			await createPreviewDeployment({
				applicationId,
				pullRequestNumber: trimmed,
			});
			toast.success(`Preview ${trimmed} deployment started`);
			setIsOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Error deploying the preview image",
			);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg w-full">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Container className="size-5" />
						Deploy image preview
					</DialogTitle>
					<DialogDescription>
						Pull the preview image for a pull request number or tag and deploy
						it as a preview. Deploying an existing preview again pulls the
						image again.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					{!isPreviewDeploymentsActive && (
						<AlertBlock type="warning">
							Preview deployments are disabled for this application.
						</AlertBlock>
					)}
					{!previewDockerImage && (
						<AlertBlock type="warning">
							Set a preview image template in the preview settings first, for
							example{" "}
							<code>{`ghcr.io/acme/app:pr-${PREVIEW_IMAGE_PLACEHOLDER}`}</code>.
						</AlertBlock>
					)}
					<div className="grid gap-2">
						<Label htmlFor="docker-preview-identifier">
							Pull request number or tag
						</Label>
						<Input
							id="docker-preview-identifier"
							placeholder="42"
							value={identifier}
							onChange={(e) => setIdentifier(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									void handleDeploy();
								}
							}}
						/>
						{trimmed && !isValid && (
							<span className="text-sm text-destructive">
								Use 1 to 63 letters, digits or "-", starting and ending with a letter or digit.
							</span>
						)}
					</div>
					{image && (
						<div className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
							<span className="text-muted-foreground">Image to pull</span>
							<span className="font-mono break-all">{image}</span>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={() => setIsOpen(false)}>
						Cancel
					</Button>
					<Button
						isLoading={isPending}
						disabled={!isValid || !previewDockerImage || !isPreviewDeploymentsActive}
						onClick={handleDeploy}
					>
						<RocketIcon className="size-4" />
						Deploy preview
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
