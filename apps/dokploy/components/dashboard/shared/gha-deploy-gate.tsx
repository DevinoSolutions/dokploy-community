import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import {
	addWorkflowNames,
	GATE_OPTIONS,
	type GateMode,
	gateFormProblem,
	gateStatusLine,
	TIMEOUT_DEFAULT,
	TIMEOUT_MAX,
	TIMEOUT_MIN,
	WORKFLOW_NAME_MAX,
	WORKFLOWS_MAX,
} from "./gha-deploy-gate-model";

interface Props {
	id: string;
	type: "application" | "compose";
}

/**
 * "Deploy when": what must be true before a release from GitHub Actions goes
 * live. Shown only for a service that follows GitHub Actions; self-hosted only.
 */
export const GhaDeployGate = ({ id, type }: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: user } = api.user.get.useQuery();
	const enabled = isCloud === false && !!permissions?.gitProviders.read;
	const { data: connection, isPending } = api.ghaConnection.one.useQuery(
		{ serviceType: type, serviceId: id },
		{ enabled: enabled && !!id },
	);
	const { mutateAsync: save, isPending: isSaving } =
		api.ghaConnection.update.useMutation();
	const { mutateAsync: deployAnyway, isPending: isDeploying } =
		api.ghaConnection.deployAnyway.useMutation();

	const [mode, setMode] = useState<GateMode>("image");
	const [workflows, setWorkflows] = useState<string[]>([]);
	const [typed, setTyped] = useState("");
	const [timeout, setTimeoutMinutes] = useState(String(TIMEOUT_DEFAULT));
	const [reason, setReason] = useState("");

	useEffect(() => {
		if (!connection) return;
		setMode(connection.gateMode as GateMode);
		setWorkflows(connection.gateWorkflows ?? []);
		setTimeoutMinutes(String(connection.gateTimeoutMinutes ?? TIMEOUT_DEFAULT));
	}, [connection]);

	if (!enabled || isPending || !connection) return null;

	// Names typed but not yet added count as added when the form is saved.
	const effectiveWorkflows = typed.trim()
		? addWorkflowNames(workflows, typed)
		: workflows;
	const problem = gateFormProblem({
		mode,
		workflows: effectiveWorkflows,
		timeout,
	});
	const newest = connection.releases[0];
	const status = gateStatusLine(newest);
	const runUrl = newest
		? `https://github.com/${connection.repository}/actions/runs/${newest.runId}`
		: null;
	const canOverride = user?.role === "owner" || user?.role === "admin";
	const option = GATE_OPTIONS.find((o) => o.value === mode);

	const addTyped = () => {
		setWorkflows(effectiveWorkflows);
		setTyped("");
	};

	const onSave = async () => {
		if (problem) return;
		try {
			await save({
				serviceType: type,
				serviceId: id,
				gateMode: mode,
				...(mode === "workflows" ? { gateWorkflows: effectiveWorkflows } : {}),
				gateTimeoutMinutes: Number(timeout),
			});
			setTyped("");
			await utils.ghaConnection.one.invalidate();
			toast.success("Saved");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error saving");
		}
	};

	const onDeployAnyway = async () => {
		try {
			if (!newest) return;
			await deployAnyway({
				serviceType: type,
				serviceId: id,
				releaseId: newest.releaseId,
				...(reason.trim() ? { reason: reason.trim() } : {}),
			});
			setReason("");
			await utils.ghaConnection.one.invalidate();
			toast.success("This release will be deployed now");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Deploy when</CardTitle>
				<CardDescription>
					Choose what must be true before a new release goes live.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{status && (
					<div className="flex flex-row flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
						<Badge
							variant={status.tone === "blocked" ? "destructive" : "secondary"}
						>
							{status.tone === "blocked" ? "Blocked" : "Waiting"}
						</Badge>
						<span className="min-w-0 flex-1">{status.text}</span>
						{canOverride && (
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button variant="outline" size="sm" isLoading={isDeploying}>
										Deploy anyway
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Deploy without waiting?</AlertDialogTitle>
										<AlertDialogDescription>
											Commit{" "}
											<span className="font-mono">{newest?.sha.slice(0, 7)}</span>{" "}
											goes live now, whatever its checks say.{" "}
											{runUrl && (
												<a
													href={runUrl}
													target="_blank"
													rel="noreferrer"
													className="underline"
												>
													See the run
												</a>
											)}{" "}
											This is logged with your name.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<Input
										placeholder="Why (optional)"
										maxLength={300}
										value={reason}
										onChange={(event) => setReason(event.target.value)}
									/>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction onClick={onDeployAnyway}>
											Deploy anyway
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						)}
					</div>
				)}

				<div className="flex flex-col gap-2 md:max-w-sm">
					<Label>Deploy when</Label>
					<Select
						value={mode}
						onValueChange={(value) => setMode(value as GateMode)}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GATE_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{option && (
						<span className="text-xs text-muted-foreground">{option.hint}</span>
					)}
				</div>

				{mode === "workflows" && (
					<div className="flex flex-col gap-2">
						<Label>Workflows</Label>
						<div className="flex flex-wrap gap-2">
							{workflows.map((name) => (
								<Badge key={name} variant="secondary" className="gap-1">
									{name}
									<button
										type="button"
										aria-label={`Remove ${name}`}
										onClick={() =>
											setWorkflows(workflows.filter((w) => w !== name))
										}
									>
										<X className="size-3" />
									</button>
								</Badge>
							))}
						</div>
						<Input
							placeholder="Workflow name, then Enter"
							className="md:max-w-sm"
							value={typed}
							maxLength={WORKFLOW_NAME_MAX}
							disabled={workflows.length >= WORKFLOWS_MAX}
							onChange={(event) => setTyped(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === ",") {
									event.preventDefault();
									addTyped();
								}
							}}
							onBlur={addTyped}
						/>
						<span className="text-xs text-muted-foreground">
							The name shown in GitHub, or the file name (ci.yml).
						</span>
					</div>
				)}

				{mode !== "image" && (
					<Collapsible>
						<CollapsibleTrigger asChild>
							<Button variant="ghost" size="sm" className="gap-1 px-0">
								Advanced
								<ChevronDown className="size-4" />
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent className="flex flex-col gap-2 pt-2">
							<Label>Stop waiting after (minutes)</Label>
							<Input
								type="number"
								className="md:max-w-[10rem]"
								min={TIMEOUT_MIN}
								max={TIMEOUT_MAX}
								value={timeout}
								onChange={(event) => setTimeoutMinutes(event.target.value)}
							/>
							<span className="text-xs text-muted-foreground">
								If a check never shows up, the release is held and you can
								deploy it anyway.
							</span>
						</CollapsibleContent>
					</Collapsible>
				)}

				{problem && <span className="text-sm text-destructive">{problem}</span>}
				<div>
					<Button onClick={onSave} isLoading={isSaving} disabled={!!problem}>
						Save
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
