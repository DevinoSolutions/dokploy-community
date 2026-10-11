import { api } from "@/utils/api";
import { SnapvisorProjectPicker } from "./snapvisor-project-picker";

/**
 * The Snapvisor project picker for a service's Deployments tab: links the
 * application or compose service to a Snapvisor project so each deployment
 * shows the build of its commit. The same `snapvisorProjectName` setting the
 * preview-deployment settings edit. Shows nothing until Snapvisor is
 * connected (the Integrations page is where that is offered).
 */
export const SnapvisorServiceLink = ({
	type,
	id,
	snapvisorProjectName,
}: {
	type: "application" | "compose";
	id: string;
	snapvisorProjectName: string | null | undefined;
}) => {
	const utils = api.useUtils();
	const { mutateAsync: setApplicationProject } =
		api.snapvisor.setApplicationProject.useMutation();
	const { mutateAsync: setComposeProject } =
		api.snapvisor.setComposeProject.useMutation();

	return (
		<SnapvisorProjectPicker
			scope="deployments"
			hideWhenNotConnected
			serviceNoun={type === "application" ? "application" : "compose service"}
			currentProjectName={snapvisorProjectName}
			save={async (projectName) => {
				if (type === "application") {
					await setApplicationProject({ applicationId: id, projectName });
					await utils.application.one.invalidate({ applicationId: id });
				} else {
					await setComposeProject({ composeId: id, projectName });
					await utils.compose.one.invalidate({ composeId: id });
				}
				// The rows decide whether to show a badge from this setting.
				await utils.snapvisor.deploymentBuild.invalidate();
			}}
		/>
	);
};
