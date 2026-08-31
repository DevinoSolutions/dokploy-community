export interface ChangeRequest {
	id: number;
	number: number;
	title: string;
	url: string;
	branch: string;
	baseBranch: string;
	draft: boolean;
	/**
	 * Author handle — GitHub `pull_request.user.login`, GitLab `author.username`.
	 * Carried so a manually triggered preview can run the same collaborator check
	 * the webhook handlers run against the change request author.
	 */
	authorUsername: string | null;
	/**
	 * Numeric author id. GitLab only: it matches `object_attributes.author_id`
	 * from the merge request webhook, which is what the member permission check
	 * authorizes against. Null for GitHub, which authorizes by login.
	 */
	authorId: number | null;
}
