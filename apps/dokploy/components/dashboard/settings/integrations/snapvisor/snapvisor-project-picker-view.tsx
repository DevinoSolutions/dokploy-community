import { LearnMoreLink } from "@/components/shared/learn-more-link";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { INTEGRATION_LEARN_MORE_URLS } from "../integration-links";
import { PoweredBySnapvisor, SnapvisorMark } from "./snapvisor-logo";

export const SNAPVISOR_OFF = "__off__";

/**
 * Where the picker is shown. The link between a service and a Snapvisor
 * project is one setting (`snapvisorProjectName`); it is offered both in the
 * preview-deployment settings and, for regular deploys, on the Deployments
 * tab.
 */
export type SnapvisorPickerScope = "previews" | "deployments";

export const snapvisorPickerCopy = (
	scope: SnapvisorPickerScope,
	serviceNoun: string,
) =>
	scope === "previews"
		? {
				description:
					"Register each preview deployment with a Snapvisor project so its visual-diff status shows on the preview card.",
				notConnected: `to show visual-diff status on this ${serviceNoun}'s previews.`,
			}
		: {
				description: `Link this ${serviceNoun} to a Snapvisor project to see the visual-diff status of each deployment's commit, and to be notified when changes need review.`,
				notConnected: `to show visual-diff status on this ${serviceNoun}'s deployments.`,
			};

export interface SnapvisorProjectPickerViewProps {
	scope: SnapvisorPickerScope;
	/** "application" or "compose service", used in the copy. */
	serviceNoun: string;
	/** Still finding out whether the organization has an integration. */
	isLoadingIntegration: boolean;
	hasIntegration: boolean;
	/** Hide the "connect Snapvisor" hint when there is no integration. */
	hideWhenNotConnected?: boolean;
	currentProjectName: string | null | undefined;
	projects: { id: string; name: string }[] | undefined;
	isLoadingProjects: boolean;
	projectsError?: string | null;
	isSaving: boolean;
	onChange: (value: string) => void;
}

/**
 * Visual testing (Snapvisor) section: which Snapvisor project a service's
 * deployments register their commit against. Shared by application and compose
 * services and by both places the picker lives; the connected wrapper owns the
 * queries and the mutation. It must not use the react-hook-form `Form*`
 * components: the Deployments tab renders it outside any form.
 */
export const SnapvisorProjectPickerView = ({
	scope,
	serviceNoun,
	isLoadingIntegration,
	hasIntegration,
	hideWhenNotConnected = false,
	currentProjectName,
	projects,
	isLoadingProjects,
	projectsError,
	isSaving,
	onChange,
}: SnapvisorProjectPickerViewProps) => {
	if (isLoadingIntegration) return null;
	const copy = snapvisorPickerCopy(scope, serviceNoun);

	if (!hasIntegration) {
		if (hideWhenNotConnected) return null;
		return (
			<div className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-xs text-sm text-muted-foreground">
				<span>
					Connect Snapvisor in{" "}
					<a href="/dashboard/settings/integrations" className="underline">
						Settings → Integrations
					</a>{" "}
					{copy.notConnected}
				</span>
				<LearnMoreLink
					href={INTEGRATION_LEARN_MORE_URLS.snapvisor}
					className="shrink-0"
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2 p-3 border rounded-lg shadow-xs">
			<div className="flex flex-row items-center justify-between">
				<div className="flex flex-row items-start gap-3">
					<SnapvisorMark className="size-8 shrink-0" />
					<div className="space-y-0.5">
						<Label>Visual testing (Snapvisor)</Label>
						<p className="text-sm text-muted-foreground">{copy.description}</p>
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
					Could not load the Snapvisor projects: {projectsError}
				</p>
			)}
			<div className="flex flex-row items-center justify-between gap-2">
				<LearnMoreLink href={INTEGRATION_LEARN_MORE_URLS.snapvisor} />
				<PoweredBySnapvisor />
			</div>
		</div>
	);
};
