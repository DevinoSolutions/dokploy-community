import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/utils/api";
import {
	SNAPVISOR_OFF,
	type SnapvisorPickerScope,
	SnapvisorProjectPickerView,
} from "./snapvisor-project-picker-view";

/**
 * Visual testing (Snapvisor) section: which Snapvisor project a service's
 * deployments register their commit against. Shared by application and compose
 * services; the caller owns the mutation (`save`) and the refetch of the
 * service. Hidden (with a hint, unless `hideWhenNotConnected`) when the
 * organization has no Snapvisor integration.
 */
export const SnapvisorProjectPicker = ({
	currentProjectName,
	save,
	serviceNoun,
	scope = "previews",
	hideWhenNotConnected = false,
}: {
	currentProjectName: string | null | undefined;
	/** Persists the choice (`null` = off); rejects with the server error. */
	save: (projectName: string | null) => Promise<unknown>;
	/** "application" or "compose service", used in the copy. */
	serviceNoun: string;
	/** Where it is shown; only changes the copy. */
	scope?: SnapvisorPickerScope;
	hideWhenNotConnected?: boolean;
}) => {
	const { data: integration, isPending: isLoadingIntegration } =
		api.snapvisor.one.useQuery();
	const {
		data: projects,
		isPending: isLoadingProjects,
		error: projectsError,
	} = api.snapvisor.projects.useQuery(undefined, { enabled: !!integration });
	const [isSaving, setIsSaving] = useState(false);

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
		<SnapvisorProjectPickerView
			scope={scope}
			serviceNoun={serviceNoun}
			isLoadingIntegration={isLoadingIntegration}
			hasIntegration={!!integration}
			hideWhenNotConnected={hideWhenNotConnected}
			currentProjectName={currentProjectName}
			projects={projects}
			isLoadingProjects={isLoadingProjects}
			projectsError={projectsError?.message}
			isSaving={isSaving}
			onChange={onChange}
		/>
	);
};
