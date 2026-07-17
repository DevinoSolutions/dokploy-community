import { Trash2 } from "lucide-react";
import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

interface Props {
	backupPolicyId: string;
	name: string;
}

export const DeleteBackupPolicy = ({ backupPolicyId, name }: Props) => {
	const [deleteBackups, setDeleteBackups] = useState(false);
	const utils = api.useUtils();
	const { mutateAsync, isPending } = api.backupPolicy.remove.useMutation();

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="group hover:bg-red-500/10 size-8"
				>
					<Trash2 className="size-4 text-primary group-hover:text-red-500" />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete backup policy</AlertDialogTitle>
					<AlertDialogDescription>
						Delete the policy <span className="font-medium">{name}</span>. By
						default the backups it created stay in place and become regular
						manual backups — their schedules keep running and nothing is lost.
					</AlertDialogDescription>
				</AlertDialogHeader>

				<div className="flex items-start gap-2 rounded-lg border p-3">
					<Checkbox
						id="delete-policy-backups"
						checked={deleteBackups}
						onCheckedChange={(checked) => setDeleteBackups(checked === true)}
					/>
					<div className="grid gap-1">
						<Label htmlFor="delete-policy-backups" className="cursor-pointer">
							Also delete the backups this policy created
						</Label>
						<p className="text-xs text-muted-foreground">
							Removes and unschedules every managed backup instead of demoting
							them to manual backups. This cannot be undone.
						</p>
					</div>
				</div>

				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={isPending}
						onClick={async () => {
							await mutateAsync({ backupPolicyId, deleteBackups })
								.then(async () => {
									toast.success("Backup policy deleted");
									await utils.backupPolicy.all.invalidate();
									await utils.backupPolicy.coverage.invalidate();
								})
								.catch(() => {
									toast.error("Error deleting the backup policy");
								});
						}}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};
