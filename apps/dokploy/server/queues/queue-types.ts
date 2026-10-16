/**
 * Priority lane fields, carried in the job payload so the journal keeps them.
 * See docs/design/deploy-queue-priority.md.
 */
type PriorityFields = {
	/** May be picked ahead of the waiting jobs in its lane; see in-memory-queue. */
	priority?: boolean;
	/**
	 * Id of the user who asked for priority (not the email: queueList returns
	 * the payload). The deployment note resolves it to an email.
	 */
	priorityBy?: string;
};

type DeployJob =
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application";
			serverId?: string;
			/**
			 * build-policy hook: an image supplied in the deploy-hook body. When
			 * present the job deploys it by digest and does not build.
			 * See packages/server/src/services/build-policy/README.md.
			 */
			pinnedImage?: { ref: string; tag: string | null; digest: string };
	  }
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "compose";
			serverId?: string;
			freshVolumes?: boolean;
	  }
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application-preview";
			previewDeploymentId: string;
			serverId?: string;
	  }
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "compose-preview";
			previewDeploymentId: string;
			serverId?: string;
	  };

export type DeploymentJob = DeployJob & PriorityFields;
