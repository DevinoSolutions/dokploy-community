export interface ChangeRequest {
	id: number;
	number: number;
	title: string;
	url: string;
	branch: string;
	baseBranch: string;
	draft: boolean;
}
