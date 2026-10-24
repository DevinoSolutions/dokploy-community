import { ShieldOff } from "lucide-react";
import { toast } from "sonner";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

/**
 * "Exclude from the restricted-compose audit": an organization owner or admin
 * opts this compose out of the read-only audit (others see the switch, and
 * cannot change it). Off by default. Self-hosted only, like the audit card in
 * Settings > Deployments.
 */
export const ComposePolicyAuditExclusion = ({ composeId }: Props) => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: auth } = api.user.get.useQuery();
	const isAdmin = auth?.role === "owner" || auth?.role === "admin";
	const query = api.compose.composePolicyAuditExclusion.useQuery(
		{ composeId },
		{ enabled: !!composeId && isCloud === false },
	);
	const { mutateAsync: setExclusion, isPending: isSaving } =
		api.compose.setComposePolicyAuditExclusion.useMutation();

	// Not known yet counts as Cloud: nothing flickers in, and no query is sent.
	if (isCloud !== false) return null;

	const onChange = async (excluded: boolean) => {
		try {
			await setExclusion({ composeId, excluded });
			await query.refetch();
			toast.success(
				excluded
					? "Excluded from the restricted-compose audit"
					: "The restricted-compose audit applies again",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error saving the setting",
			);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div className="flex flex-row items-center gap-2">
					<ShieldOff className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">
							Exclude from the restricted-compose audit
						</CardTitle>
						<CardDescription>
							When on, deployments of this compose are never evaluated by the
							read-only restricted-compose audit and leave no findings. Off by
							default.
							{isAdmin
								? ""
								: " Only an organization owner or admin can change this."}
							{query.data && !query.data.auditEnabled
								? " The audit is currently turned off for the whole organization."
								: ""}
						</CardDescription>
					</div>
				</div>
				<Switch
					checked={query.data?.excluded ?? false}
					disabled={isSaving || query.isLoading || !isAdmin}
					onCheckedChange={onChange}
				/>
			</CardHeader>
		</Card>
	);
};
