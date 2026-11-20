import type { ServiceType } from "@dokploy/server/db/schema";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { DrawerLogs } from "@/components/shared/drawer-logs";
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
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { type LogLine, parseLogs } from "../docker/logs/utils";

const LOCAL_SERVER = "dokploy";

const transferSchema = z.object({
	targetServerId: z.string().min(1, { message: "Select a target server" }),
	removeSourceData: z.boolean(),
});

type TransferForm = z.infer<typeof transferSchema>;

interface Props {
	id: string;
	type: ServiceType;
	serverId?: string | null;
}

export const TransferService = ({ id, type, serverId }: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: servers } = api.server.withSSHKey.useQuery();
	const [isOpen, setIsOpen] = useState(false);
	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [isTransferring, setIsTransferring] = useState(false);
	const [logs, setLogs] = useState<LogLine[]>([]);
	const [request, setRequest] = useState<{
		targetServerId: string | null;
		removeSourceData: boolean;
		overwriteTargets: string[];
	} | null>(null);
	const [isChecking, setIsChecking] = useState(false);
	// What the pre-flight found when the target already holds data or the
	// transfer is refused: shown in the dialog before anything is started.
	const [review, setReview] = useState<{
		request: {
			targetServerId: string | null;
			removeSourceData: boolean;
		};
		needsOverwrite: string[];
		blockers: string[];
		composeHostBinds: { service: string; source: string }[];
	} | null>(null);
	const [confirmOverwrite, setConfirmOverwrite] = useState(false);

	const targets = [
		...(!isCloud && serverId
			? [{ serverId: LOCAL_SERVER, name: "Dokploy Server" }]
			: []),
		...(servers ?? []).filter((server) => server.serverId !== serverId),
	];

	const form = useForm<TransferForm>({
		defaultValues: { targetServerId: "", removeSourceData: false },
		resolver: zodResolver(transferSchema),
	});

	api.transfer.start.useSubscription(
		{
			serviceType: type,
			serviceId: id,
			targetServerId: request?.targetServerId ?? null,
			removeSourceData: request?.removeSourceData ?? false,
			overwriteTargets: request?.overwriteTargets ?? [],
		},
		{
			enabled: isTransferring && request !== null,
			onData(line) {
				setLogs((prev) => [...prev, ...parseLogs(line)]);
				if (line.startsWith("Transfer completed")) {
					setIsTransferring(false);
					toast.success("Service transferred successfully");
					utils.invalidate();
				} else if (line.startsWith("Transfer failed")) {
					setIsTransferring(false);
					toast.error("Transfer failed, check the logs");
					utils.invalidate();
				}
			},
			onError(error) {
				setIsTransferring(false);
				toast.error(error.message);
			},
		},
	);

	const startTransfer = (
		target: { targetServerId: string | null; removeSourceData: boolean },
		overwriteTargets: string[],
	) => {
		setRequest({ ...target, overwriteTargets });
		setLogs([]);
		setReview(null);
		setConfirmOverwrite(false);
		setIsDrawerOpen(true);
		setIsTransferring(true);
		setIsOpen(false);
	};

	// The pre-flight is read-only. A transfer that would write over data on the
	// target, or that is refused, is shown here first; the volumes named in the
	// confirm step are the only ones the transfer may write over.
	const onSubmit = async (values: TransferForm) => {
		const target = {
			targetServerId:
				values.targetServerId === LOCAL_SERVER ? null : values.targetServerId,
			removeSourceData: values.removeSourceData,
		};
		setIsChecking(true);
		try {
			const preview = await utils.transfer.preflight.fetch({
				serviceType: type,
				serviceId: id,
				targetServerId: target.targetServerId,
			});
			if (
				preview.needsOverwrite.length === 0 &&
				preview.blockers.length === 0
			) {
				startTransfer(target, []);
				return;
			}
			setConfirmOverwrite(false);
			setReview({
				request: target,
				needsOverwrite: preview.needsOverwrite,
				blockers: preview.blockers,
				composeHostBinds: preview.composeHostBinds,
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not check the target",
			);
		} finally {
			setIsChecking(false);
		}
	};

	return (
		<>
			<Dialog
				open={isOpen}
				onOpenChange={(open) => {
					setIsOpen(open);
					if (!open) {
						setReview(null);
						setConfirmOverwrite(false);
					}
				}}
			>
				<DialogTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
						isLoading={isTransferring}
					>
						<ArrowRightLeft className="size-4 text-primary group-hover:text-blue-500" />
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Transfer to another server</DialogTitle>
						<DialogDescription>
							Moves this service with its volumes, bind mounts, file mounts and
							configuration to the selected server, then deploys it there.
						</DialogDescription>
					</DialogHeader>
					{review ? (
						<div className="grid w-full gap-4">
							{review.blockers.length > 0 ? (
								<AlertBlock type="error">
									<p>The transfer is refused, nothing was changed:</p>
									<ul className="list-disc pl-4 space-y-1">
										{review.blockers.map((blocker) => (
											<li key={blocker}>{blocker}</li>
										))}
									</ul>
								</AlertBlock>
							) : (
								<AlertBlock type="warning">
									<p>
										The target server already holds data under these names. The
										transfer would write over it:
									</p>
									<ul className="list-disc pl-4 space-y-1">
										{review.needsOverwrite.map((name) => (
											<li key={name} className="font-mono break-all">
												{name}
											</li>
										))}
									</ul>
								</AlertBlock>
							)}
							{review.composeHostBinds.length > 0 && (
								<AlertBlock type="info">
									<p>
										These host paths of the compose file are not copied by the
										transfer:
									</p>
									<ul className="list-disc pl-4 space-y-1">
										{review.composeHostBinds.map((bind) => (
											<li
												key={`${bind.service}:${bind.source}`}
												className="font-mono break-all"
											>
												{bind.service}: {bind.source}
											</li>
										))}
									</ul>
								</AlertBlock>
							)}
							{review.blockers.length === 0 && (
								<div className="flex items-center">
									<Checkbox
										id="transfer-confirm-overwrite"
										checked={confirmOverwrite}
										onCheckedChange={(checked) =>
											setConfirmOverwrite(checked === true)
										}
									/>
									<label
										htmlFor="transfer-confirm-overwrite"
										className="ml-2 text-sm"
									>
										Write over the data listed above on the target server
									</label>
								</div>
							)}
						</div>
					) : targets.length === 0 ? (
						<AlertBlock type="info">
							There are no other servers available to transfer this service to.
						</AlertBlock>
					) : (
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								id="hook-form-transfer-service"
								className="grid w-full gap-4"
							>
								<FormField
									control={form.control}
									name="targetServerId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Target server</FormLabel>
											<Select
												onValueChange={field.onChange}
												defaultValue={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select a server" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{targets.map((server) => (
														<SelectItem
															key={server.serverId}
															value={server.serverId}
														>
															{server.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="removeSourceData"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center">
												<FormControl>
													<Checkbox
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
												<FormLabel className="ml-2">
													Remove volumes from the source server after the
													transfer
												</FormLabel>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>
								<AlertBlock type="warning">
									<ul className="list-disc pl-4 space-y-1">
										<li>The service is stopped while its data is copied.</li>
										<li>
											Point your DNS records to the new server, certificates are
											issued again there.
										</li>
										<li>
											Networks that only exist on the current server are
											detached.
										</li>
										<li>
											Bind mount host paths are copied but never deleted from
											the source server.
										</li>
									</ul>
								</AlertBlock>
							</form>
						</Form>
					)}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setIsOpen(false)}>
							Cancel
						</Button>
						{review && review.blockers.length === 0 && (
							<Button
								disabled={!confirmOverwrite}
								onClick={() =>
									startTransfer(review.request, review.needsOverwrite)
								}
							>
								Transfer and write over
							</Button>
						)}
						{review && (
							<Button variant="outline" onClick={() => setReview(null)}>
								Back
							</Button>
						)}
						{!review && targets.length > 0 && (
							<Button
								isLoading={isTransferring || isChecking}
								form="hook-form-transfer-service"
								type="submit"
							>
								Transfer
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<DrawerLogs
				isOpen={isDrawerOpen}
				onClose={() => setIsDrawerOpen(false)}
				filteredLogs={logs}
			/>
		</>
	);
};
