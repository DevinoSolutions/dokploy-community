import { useState } from "react";
import { toast } from "sonner";
import { LearnMoreLink } from "@/components/shared/learn-more-link";
import { FormDescription, FormLabel } from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { INTEGRATION_LEARN_MORE_URLS } from "../integration-links";
import { PoweredBySnapvisor, SnapvisorMark } from "./snapvisor-logo";

const SNAPVISOR_OFF = "__off__";

/**
 * Visual testing (Snapvisor) section: which Snapvisor project a service's
 * preview deployments register their commit against. Shared by application
 * and compose previews; the caller owns the mutation (`save`) and the refetch
 * of the service. Hidden (with a hint) when the organization has no Snapvisor
 * integration.
 */
export const SnapvisorProjectPicker = ({
	currentProjectName,
	save,
	serviceNoun,
}: {
	currentProjectName: string | null | undefined;
	/** Persists the choice (`null` = off); rejects with the server error. */
	save: (projectName: string | null) => Promise<unknown>;
	/** "application" or "compose service", used in the copy. */
	serviceNoun: string;
}) => {
	const { data: integration, isPending: isLoadingIntegration } =
		api.snapvisor.one.useQuery();
	const {
		data: projects,
		isPending: isLoadingProjects,
		error: projectsError,
	} = api.snapvisor.projects.useQuery(undefined, { enabled: !!integration });
	const [isSaving, setIsSaving] = useState(false);

	if (isLoadingIntegration) return null;

	if (!integration) {
		return (
			<div className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-xs text-sm text-muted-foreground">
				<span>
					Connect Snapvisor in{" "}
					<a href="/dashboard/settings/integrations" className="underline">
						Settings → Integrations
					</a>{" "}
					to show visual-diff status on this {serviceNoun}&apos;s previews.
				</span>
				<LearnMoreLink
					href={INTEGRATION_LEARN_MORE_URLS.snapvisor}
					className="shrink-0"
				/>
			</div>
		);
	}

	const onChange = async (value: string) => {
		const projectName = value === SNAPVISOR_OFF ? null : value;
		setIsSaving(true);
		await save(projectName)
			.then(() => {
				toast.success(
					projectName
						? `Visual testing linked to "${projectName}"`
						: "Visual testing turned off",
				);
			})
			.catch((error) => {
				toast.error("Error updating the Snapvisor project", {
					description: error.message,
				});
			})
			.finally(() => setIsSaving(false));
	};

	return (
		<div className="flex flex-col gap-2 p-3 border rounded-lg shadow-xs">
			<div className="flex flex-row items-center justify-between">
				<div className="flex flex-row items-start gap-3">
					<SnapvisorMark className="size-8 shrink-0" />
					<div className="space-y-0.5">
						<FormLabel>Visual testing (Snapvisor)</FormLabel>
						<FormDescription>
							Register each preview deployment with a Snapvisor project so its
							visual-diff status shows on the preview card.
						</FormDescription>
					</div>
				</div>
			</div>
			<Select
				value={currentProjectName ?? SNAPVISOR_OFF}
				onValueChange={onChange}
				disabled={isSaving || isLoadingProjects}
			>
				<SelectTrigger>
					<SelectValue placeholder="Off" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={SNAPVISOR_OFF}>Off</SelectItem>
					{projects?.map((project) => (
						<SelectItem key={project.id} value={project.name}>
							{project.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{projectsError && (
				<p className="text-sm text-red-600" role="alert">
					Could not load the Snapvisor projects: {projectsError.message}
				</p>
			)}
			<div className="flex flex-row items-center justify-between gap-2">
				<LearnMoreLink href={INTEGRATION_LEARN_MORE_URLS.snapvisor} />
				<PoweredBySnapvisor />
			</div>
		</div>
	);
};
