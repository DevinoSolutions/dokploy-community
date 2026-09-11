import { ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

export const BuildPolicyAudit = () => {
	const { data } = api.buildPolicy.audit.useQuery({ limit: 50, offset: 0 });

	const logs = data?.logs ?? [];

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<ScrollText className="size-6 text-muted-foreground self-center" />
								Build Policy Audit
							</CardTitle>
							<CardDescription>
								The 50 most recent build policy decisions for this organization.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-4 py-6 border-t">
						{logs.length > 0 ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Date</TableHead>
										<TableHead>Action</TableHead>
										<TableHead>Service</TableHead>
										<TableHead>Actor</TableHead>
										<TableHead>Reason</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{logs.map((log) => (
										<TableRow key={log.buildPolicyAuditId}>
											<TableCell className="text-muted-foreground whitespace-nowrap">
												{new Date(log.createdAt).toLocaleString()}
											</TableCell>
											<TableCell>
												<Badge variant="blank">{log.action}</Badge>
											</TableCell>
											<TableCell>
												{log.application?.name ?? log.compose?.name ?? "-"}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{log.actorEmail || "-"}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{log.reason || "-"}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						) : (
							<p className="text-sm text-muted-foreground">No entries yet</p>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
