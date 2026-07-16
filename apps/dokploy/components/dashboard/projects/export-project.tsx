import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { slugify } from "@/lib/slug";
import { api } from "@/utils/api";

interface Props {
	projectId: string;
	projectName?: string;
	children?: React.ReactNode;
}

export const ExportProject = ({ projectId, projectName, children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [includeSecrets, setIncludeSecrets] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const utils = api.useUtils();

	const onExport = async () => {
		setIsExporting(true);
		try {
			const data = await utils.project.export.fetch({
				projectId,
				includeSecrets,
			});
			const blob = new Blob([JSON.stringify(data, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${slugify(projectName || "project")}-export.json`;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);
			toast.success("Project exported successfully");
			setIsOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error exporting the project",
			);
		} finally {
			setIsExporting(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						onSelect={(e) => e.preventDefault()}
					>
						<DownloadIcon className="size-4" />
						<span>Export</span>
					</DropdownMenuItem>
				)}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Export project</DialogTitle>
					<DialogDescription>
						Download this project's configuration (environments, services,
						domains, mounts and ports) as a JSON file.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex items-center gap-3">
						<Checkbox
							id="include-secrets"
							checked={includeSecrets}
							onCheckedChange={(checked) => setIncludeSecrets(checked === true)}
						/>
						<label
							htmlFor="include-secrets"
							className="text-sm font-medium leading-none cursor-pointer"
						>
							Include secrets (environment variables, passwords, tokens)
						</label>
					</div>
					{includeSecrets && (
						<AlertBlock type="warning">
							The exported file will contain plaintext secrets. Store and share
							it carefully.
						</AlertBlock>
					)}
				</div>

				<DialogFooter>
					<Button isLoading={isExporting} onClick={onExport}>
						Download JSON
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
