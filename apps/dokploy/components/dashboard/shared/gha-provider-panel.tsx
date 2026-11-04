import { githubNewFileUrl } from "@dokploy/server/services/gha-connect/workflow-snippet";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, useId, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import { GhaDeployGate } from "./gha-deploy-gate";
import { GATE_OPTIONS, type GateMode } from "./gha-deploy-gate-model";
import {
	type ConnectForm,
	type ConnectMode,
	connectFormProblem,
	defaultConnectForm,
	describeProviderStatus,
	effectiveMode,
	effectiveServiceKey,
	effectiveWorkflowPath,
	environmentAdvice,
	isMirrored,
	type PillTone,
	panelImageOfConnection,
	providerDetailRows,
	runningImageProblem,
	type ServiceKind,
	snippetProblem,
	toConnectInput,
	toSnippetInput,
	workflowImageOfForm,
} from "./gha-provider-model";

interface Props {
	id: string;
	type: ServiceKind;
	/** What the service already knows: the repository and branch it builds from, if any. */
	defaults?: { repository?: string | null; branch?: string | null };
}

const PILL_VARIANT: Record<PillTone, "green" | "yellow" | "red" | "blank"> = {
	good: "green",
	warn: "yellow",
	bad: "red",
	neutral: "blank",
};

const NOTE = "text-sm text-muted-foreground";

/**
 * Whether the service has a GitHub Actions connection, whatever its source type says (a connection made before the
 * provider existed is adopted at the next start; until then the tab still has to show it).
 */
export const useHasGhaConnection = (id: string, type: ServiceKind): boolean => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const enabled = isCloud === false && !!permissions?.gitProviders.read;
	const { data } = api.ghaConnection.one.useQuery(
		{ serviceType: type, serviceId: id },
		{ enabled: enabled && !!id },
	);
	return !!data;
};

/**
 * The "GitHub Actions" option of a service's Provider tab. Not connected: the Connect flow (Copy the file).
 * Connected: what GitHub Actions deployed, the way out of every state, and the deploy rule. Self-hosted only.
 */
export const GhaProviderPanel = ({ id, type, defaults }: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const enabled = isCloud === false && !!permissions?.gitProviders.read;
	const { data: connection, isPending } = api.ghaConnection.one.useQuery(
		{ serviceType: type, serviceId: id },
		{ enabled: enabled && !!id, refetchInterval: 15_000 },
	);

	if (isCloud === true) {
		return (
			<p className={NOTE}>
				GitHub Actions releases are available on self-hosted Dokploy only.
			</p>
		);
	}
	if (permissions && !permissions.gitProviders.read) {
		return (
			<p className={NOTE}>
				You need access to Git Providers to connect GitHub Actions.
			</p>
		);
	}
	if (!enabled || isPending) {
		return (
			<div className="flex min-h-[25vh] items-center justify-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Loading...
			</div>
		);
	}

	const refreshService = async () => {
		await utils.ghaConnection.one.invalidate();
		if (type === "application") await utils.application.one.invalidate();
		else await utils.compose.one.invalidate();
	};

	return connection ? (
		<ConnectedView
			id={id}
			type={type}
			connection={connection}
			onChanged={refreshService}
		/>
	) : (
		<ConnectFlow
			id={id}
			type={type}
			defaults={defaults}
			onChanged={refreshService}
		/>
	);
};

/* ------------------------------------------------------------------ connected */

type Connection = NonNullable<RouterOutputs["ghaConnection"]["one"]>;

const ConnectedView = ({
	id,
	type,
	connection,
	onChanged,
}: {
	id: string;
	type: ServiceKind;
	connection: Connection;
	onChanged: () => Promise<void>;
}) => {
	const checkNow = api.ghaConnection.checkNow.useMutation();
	const disconnect = api.ghaConnection.disconnect.useMutation();
	const status = describeProviderStatus(connection);
	// What the release will pin, from what the service runs (the same queries the service page already makes).
	const { data: application } = api.application.one.useQuery(
		{ applicationId: id },
		{ enabled: type === "application" },
	);
	const { data: composeService } = api.compose.one.useQuery(
		{ composeId: id },
		{ enabled: type === "compose" },
	);
	const image = panelImageOfConnection(connection, type, {
		dockerImage: application?.dockerImage,
		composeFile: composeService?.composeFile,
	});
	const rows = providerDetailRows(connection, new Date(), image);

	return (
		<div className="flex flex-col gap-4 p-2">
			<div className="flex flex-col gap-2 rounded-md border p-4">
				<div className="flex flex-row flex-wrap items-center gap-2">
					<Badge variant={PILL_VARIANT[status.pill.tone]}>
						{status.pill.label}
					</Badge>
					<span className="min-w-0 flex-1 text-sm">{status.sentence}</span>
				</div>
				{status.exit && <p className={NOTE}>{status.exit}</p>}
				{connection.lastError && connection.state !== "connected" && (
					<p className="text-sm text-destructive">{connection.lastError}</p>
				)}
			</div>

			<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
				{rows.map((row) => (
					<div key={row.label} className="contents">
						<dt className="text-muted-foreground">{row.label}</dt>
						<dd className={row.mono ? "font-mono" : undefined}>
							{row.href ? (
								<a
									href={row.href}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 underline"
								>
									{row.value}
									<ExternalLink className="size-3" />
								</a>
							) : (
								row.value
							)}
						</dd>
					</div>
				))}
			</dl>

			<div className="flex flex-row flex-wrap gap-2">
				{status.actions.includes("checkNow") && (
					<Button
						variant="secondary"
						isLoading={checkNow.isPending}
						onClick={async () => {
							try {
								await checkNow.mutateAsync({
									serviceType: type,
									serviceId: id,
								});
								await onChanged();
								toast.success("Checking GitHub now");
							} catch (error) {
								toast.error(
									error instanceof Error ? error.message : "Error checking",
								);
							}
						}}
					>
						Check now
					</Button>
				)}
				{status.actions.includes("reconnect") && (
					<Button variant="secondary" asChild>
						<Link href="/dashboard/settings/git-providers">
							Reconnect GitHub
						</Link>
					</Button>
				)}
				<DialogAction
					title="Disconnect GitHub Actions?"
					description="The service keeps running what it runs now. It goes back to the source it had before it was connected, and releases from GitHub Actions stop deploying."
					type="destructive"
					onClick={async () => {
						try {
							await disconnect.mutateAsync({
								serviceType: type,
								serviceId: id,
								restoreSource: true,
							});
							await onChanged();
							toast.success("Disconnected from GitHub Actions");
						} catch (error) {
							toast.error(
								error instanceof Error ? error.message : "Error disconnecting",
							);
						}
					}}
				>
					<Button variant="outline" isLoading={disconnect.isPending}>
						Disconnect
					</Button>
				</DialogAction>
			</div>

			<GhaDeployGate id={id} type={type} />
		</div>
	);
};

/* ------------------------------------------------------------------ connect flow */

const ConnectFlow = ({
	id,
	type,
	defaults,
	onChanged,
}: {
	id: string;
	type: ServiceKind;
	defaults: Props["defaults"];
	onChanged: () => Promise<void>;
}) => {
	const { data: accounts } = api.githubDeployment.connections.useQuery();
	const { data: registries } = api.registry.all.useQuery();
	const connect = api.ghaConnection.connect.useMutation();
	const test = api.ghaConnection.testConnection.useMutation();

	const [form, setForm] = useState<ConnectForm>(() =>
		defaultConnectForm(defaults),
	);
	const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(
		null,
	);
	const [copied, setCopied] = useState(false);
	const set = <K extends keyof ConnectForm>(key: K, value: ConnectForm[K]) => {
		setForm((current) => ({ ...current, [key]: value }));
		setTested(null);
	};

	const mode = effectiveMode(form);
	const mirrored = isMirrored(form);
	const snippetInvalid = snippetProblem(form);
	// What the service runs decides the image the workflow pushes and whether a release can ever replace it.
	const { data: runningApplication } = api.application.one.useQuery(
		{ applicationId: id },
		{ enabled: type === "application" },
	);
	const { data: runningCompose } = api.compose.one.useQuery(
		{ composeId: id },
		{ enabled: type === "compose" },
	);
	const running = {
		dockerImage: runningApplication?.dockerImage,
		composeFile: runningCompose?.composeFile,
	};
	// A running image no release could replace stops Connect here, as it does on the server.
	const problem =
		connectFormProblem(form) ?? runningImageProblem(form, type, running);
	const { data: snippet } = api.ghaConnection.snippet.useQuery(
		toSnippetInput(form, workflowImageOfForm(form, type, running)),
		{ enabled: snippetInvalid === null, retry: false },
	);

	const input = () =>
		toConnectInput(form, { serviceType: type, serviceId: id });

	const onTest = async () => {
		if (problem) return;
		try {
			const result = await test.mutateAsync(input());
			setTested(
				result.ok
					? {
							ok: true,
							message: `Everything checks out in ${result.repository}. Connect to start following its releases.`,
						}
					: { ok: false, message: result.message },
			);
		} catch (error) {
			setTested({
				ok: false,
				message: error instanceof Error ? error.message : "Error testing",
			});
		}
	};

	const onConnect = async () => {
		if (problem) return;
		try {
			await connect.mutateAsync(input());
			await onChanged();
			toast.success("Connected. Dokploy now waits for the first release.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error connecting");
		}
	};

	const onCopy = async () => {
		if (!snippet) return;
		await navigator.clipboard.writeText(snippet.yaml);
		setCopied(true);
		toast.success(
			snippet.kind === "file"
				? `Copied. Save it as ${snippet.path} in your repository.`
				: "Copied. Paste it under jobs: in your workflow file.",
		);
	};

	const newFileUrl =
		snippet?.kind === "file" && snippet.path
			? githubNewFileUrl({
					repository: form.repository.trim(),
					branch: form.trackedBranch.trim(),
					path: snippet.path,
					yaml: snippet.yaml,
				})
			: null;

	if (accounts && accounts.length === 0) {
		return (
			<div className="flex min-h-[25vh] flex-col items-center justify-center gap-3 text-center">
				<span className="text-base text-muted-foreground">
					To follow GitHub Actions releases, connect a GitHub account first.
					It is added under Settings, Git providers.
				</span>
				<Button variant="secondary" asChild>
					<Link href="/dashboard/settings/git-providers">
						Open Git providers
					</Link>
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5 p-2">
			<p className={NOTE}>
				Your repository's workflow builds the image and publishes a release.
				Dokploy asks GitHub for it, checks it against the run, and deploys the
				image. Nothing connects to Dokploy from outside, and no Dokploy key goes
				into the repository.
			</p>

			<div className="grid gap-4 md:grid-cols-2">
				<Field label="GitHub account">
					<Select
						value={form.githubConnectionId}
						onValueChange={(value) => set("githubConnectionId", value)}
					>
						<FieldSelectTrigger>
							<SelectValue placeholder="Choose an account" />
						</FieldSelectTrigger>
						<SelectContent>
							{(accounts ?? []).map((account) => (
								<SelectItem
									key={account.connectionId}
									value={account.connectionId}
								>
									{account.githubLogin}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Repository">
					<FieldInput
						placeholder="acme/shop"
						value={form.repository}
						onChange={(event) => set("repository", event.target.value)}
					/>
				</Field>
				<Field label="Branch" hint="A push to it publishes a release.">
					<FieldInput
						value={form.trackedBranch}
						onChange={(event) => set("trackedBranch", event.target.value)}
					/>
				</Field>
				<Field label="GitHub environment">
					<FieldInput
						value={form.environment}
						onChange={(event) => set("environment", event.target.value)}
					/>
				</Field>
				<Field
					label="Service key"
					hint="Names this service in the release. The repository name by default."
				>
					<FieldInput
						placeholder={effectiveServiceKey(form)}
						value={form.serviceKey}
						onChange={(event) => set("serviceKey", event.target.value)}
					/>
				</Field>
				<Field
					label="Images are mirrored to a registry"
					hint="Only if your workflow copies the image to a private registry of yours."
				>
					<Select
						value={form.registryId}
						onValueChange={(value) => set("registryId", value)}
					>
						<FieldSelectTrigger>
							<SelectValue />
						</FieldSelectTrigger>
						<SelectContent>
							<SelectItem value="none">No, public GHCR images</SelectItem>
							{(registries ?? []).map((entry) => (
								<SelectItem key={entry.registryId} value={entry.registryId}>
									{entry.registryName} ({entry.registryUrl})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				{mirrored && (
					<Field
						label="How the images are named in a release"
						hint="Host and path exactly as the release writes them."
					>
						<FieldInput
							placeholder="localhost:5000/registry.devino.ca"
							value={form.registryPrefix}
							onChange={(event) => set("registryPrefix", event.target.value)}
						/>
					</Field>
				)}
			</div>

			<div className="flex flex-col gap-3 rounded-md border p-4">
				<div className="flex flex-col gap-2 md:max-w-md">
					<Label htmlFor="gha-who-builds">Who builds the image</Label>
					<Select
						value={mode}
						disabled={mirrored}
						onValueChange={(value) => set("mode", value as ConnectMode)}
					>
						<FieldSelectTrigger id="gha-who-builds">
							<SelectValue />
						</FieldSelectTrigger>
						<SelectContent>
							<SelectItem value="build">
								The Dokploy action builds it from a Dockerfile
							</SelectItem>
							<SelectItem value="existing">
								My workflow already builds it
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
				{mode === "build" ? (
					<div className="grid gap-4 md:grid-cols-2">
						<Field label="Dockerfile">
							<FieldInput
								value={form.dockerfile}
								onChange={(event) => set("dockerfile", event.target.value)}
							/>
						</Field>
						<Field label="Build directory">
							<FieldInput
								value={form.context}
								onChange={(event) => set("context", event.target.value)}
							/>
						</Field>
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-3">
						<Field label="Your workflow file">
							<FieldInput
								value={form.workflowPath}
								onChange={(event) => set("workflowPath", event.target.value)}
							/>
						</Field>
						<Field label="Your build job (its id)">
							<FieldInput
								value={form.buildJob}
								onChange={(event) => set("buildJob", event.target.value)}
							/>
						</Field>
						<Field
							label="The image your workflow built"
							hint="The name of that job's output that holds it."
						>
							<FieldInput
								value={form.imageOutput}
								onChange={(event) => set("imageOutput", event.target.value)}
							/>
						</Field>
					</div>
				)}
				<p className={NOTE}>{environmentAdvice(form)}</p>

				{snippet ? (
					<div className="flex flex-col gap-2">
						<Label>
							{snippet.kind === "file"
								? `Create ${snippet.path}`
								: `Add this job to ${effectiveWorkflowPath(form)}`}
						</Label>
						<Textarea
							readOnly
							className="font-mono text-xs"
							rows={snippet.kind === "file" ? 22 : 18}
							value={snippet.yaml}
						/>
						<div className="flex flex-row flex-wrap items-center gap-2">
							<Button variant="secondary" onClick={onCopy}>
								{copied ? (
									<Check className="mr-2 size-4" />
								) : (
									<Copy className="mr-2 size-4" />
								)}
								{snippet.kind === "file" ? "Copy file" : "Copy job"}
							</Button>
							{newFileUrl && (
								<Button variant="outline" asChild>
									<a href={newFileUrl} target="_blank" rel="noreferrer">
										Open on GitHub
										<ExternalLink className="ml-2 size-4" />
									</a>
								</Button>
							)}
						</div>
						<p className={NOTE}>
							{newFileUrl
								? "Open on GitHub shows the file ready to commit: pick a new branch there to open a pull request. Dokploy itself never writes to your repository."
								: "Dokploy never writes to your repository: paste the job yourself. Without it no release ever arrives."}
						</p>
					</div>
				) : snippetInvalid ? (
					<p className={NOTE}>{snippetInvalid}</p>
				) : null}
			</div>

			<div className="flex flex-col gap-2 md:max-w-md">
				<Label htmlFor="gha-deploy-when">Deploy when</Label>
				<Select
					value={form.gateMode}
					onValueChange={(value) => set("gateMode", value as GateMode)}
				>
					<FieldSelectTrigger id="gha-deploy-when">
						<SelectValue />
					</FieldSelectTrigger>
					<SelectContent>
						{GATE_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<span className="text-xs text-muted-foreground">
					{GATE_OPTIONS.find((option) => option.value === form.gateMode)?.hint}
				</span>
				{form.gateMode === "workflows" && (
					<FieldInput
						placeholder="Workflow names, separated by commas"
						value={form.gateWorkflows}
						onChange={(event) => set("gateWorkflows", event.target.value)}
					/>
				)}
			</div>

			{tested && (
				<p
					className={
						tested.ok ? "text-sm text-emerald-500" : "text-sm text-destructive"
					}
				>
					{tested.message}
				</p>
			)}
			{problem && <p className={NOTE}>{problem}</p>}
			<div className="flex flex-row flex-wrap items-center gap-2">
				<Button
					variant="secondary"
					isLoading={test.isPending}
					disabled={!!problem}
					onClick={onTest}
				>
					Test connection
				</Button>
				<Button
					isLoading={connect.isPending}
					disabled={!!problem}
					onClick={onConnect}
				>
					Connect
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Connecting makes this service follow GitHub Actions: git autodeploy
				turns off so only one thing deploys it, and Disconnect puts the previous
				source back. A manual deploy only redeploys the current image.
			</p>
		</div>
	);
};

const FieldIdContext = createContext<string | undefined>(undefined);

/** An input that belongs to the label of the Field around it (click the label, focus the input). */
const FieldInput = (props: React.ComponentProps<typeof Input>) => {
	const id = useContext(FieldIdContext);
	return <Input id={props.id ?? id} {...props} />;
};

const FieldSelectTrigger = (
	props: React.ComponentProps<typeof SelectTrigger>,
) => {
	const id = useContext(FieldIdContext);
	return <SelectTrigger id={props.id ?? id} {...props} />;
};

const Field = ({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) => {
	const id = useId();
	return (
		<FieldIdContext.Provider value={id}>
			<div className="flex flex-col gap-2">
				<Label htmlFor={id}>{label}</Label>
				{children}
				{hint && <span className="text-xs text-muted-foreground">{hint}</span>}
			</div>
		</FieldIdContext.Provider>
	);
};
