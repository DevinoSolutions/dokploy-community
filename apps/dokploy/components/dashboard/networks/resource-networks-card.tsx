"use client";

import { Loader2, Network } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/utils/api";

// Compose omitted: attaches networks via compose YAML, not Swarm service spec.
export type NetworkAttachableResource =
	| "application"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

interface Props {
	resourceType: NetworkAttachableResource;
	resourceId: string;
	/** Currently-attached network ids on the resource. */
	value: string[];
	/** Server the resource deploys to — filters the picker to matching networks. */
	serverId: string | null | undefined;
}

export const ResourceNetworksCard = ({
	resourceType,
	resourceId,
	value,
	serverId,
}: Props) => {
	const { data: networks, isLoading } = api.network.all.useQuery();

	// Payload shape differs per resource; server-side zod enforces correctness.
	const applicationUpdate = api.application.update.useMutation();
	const libsqlUpdate = api.libsql.update.useMutation();
	const mariadbUpdate = api.mariadb.update.useMutation();
	const mongoUpdate = api.mongo.update.useMutation();
	const mysqlUpdate = api.mysql.update.useMutation();
	const postgresUpdate = api.postgres.update.useMutation();
	const redisUpdate = api.redis.update.useMutation();

	const update = {
		application: applicationUpdate,
		libsql: libsqlUpdate,
		mariadb: mariadbUpdate,
		mongo: mongoUpdate,
		mysql: mysqlUpdate,
		postgres: postgresUpdate,
		redis: redisUpdate,
	}[resourceType];

	const utils = api.useUtils();

	// Only networks scoped to the same server as this resource (or unscoped/local
	// when both are local). Mirrors the backend resolver's filter.
	const availableNetworks = useMemo(() => {
		const target = serverId ?? null;
		return (networks ?? []).filter((n) => (n.serverId ?? null) === target);
	}, [networks, serverId]);

	const toggle = async (networkId: string, checked: boolean) => {
		const nextIds = checked
			? [...value, networkId]
			: value.filter((id) => id !== networkId);

		try {
			const idKey = `${resourceType}Id` as const;
			const payload = {
				[idKey]: resourceId,
				networkIds: nextIds,
			};
			// The 7 resource-specific mutations share an identical shape for this
			// partial update (id + networkIds), but TS can't narrow across the
			// union of mutation types. Runtime zod on the router enforces the
			// contract, so an unknown-cast here is appropriate.
			await (update.mutateAsync as (p: unknown) => Promise<unknown>)(payload);
			// Invalidate the matching `one` query so the parent re-renders with new ids
			const invalidate = (
				utils[resourceType] as unknown as {
					one: { invalidate: (args?: unknown) => Promise<void> };
				}
			).one.invalidate;
			await invalidate({ [idKey]: resourceId });
			toast.success("Networks updated");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update networks",
			);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<Network className="size-5 text-muted-foreground" />
					Custom Networks
				</CardTitle>
				<CardDescription>
					Attach this service to additional Docker networks. The built-in{" "}
					<code>dokploy-network</code> stays attached for Traefik routing.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
						<Loader2 className="size-4 animate-spin" /> Loading networks…
					</div>
				) : availableNetworks.length === 0 ? (
					<div className="flex flex-col gap-3 py-2 text-sm text-muted-foreground">
						<p>
							No networks available for this{" "}
							{serverId ? "server" : "Dokploy host"}.
						</p>
						<Link
							href="/dashboard/networks"
							className="text-primary hover:underline"
						>
							<Button variant="outline" size="sm">
								Manage networks
							</Button>
						</Link>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{availableNetworks.map((n) => {
							const checked = value.includes(n.networkId);
							return (
								<label
									key={n.networkId}
									className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent"
								>
									<Checkbox
										checked={checked}
										disabled={update.isPending}
										onCheckedChange={(v) => toggle(n.networkId, v === true)}
									/>
									<div className="flex flex-col flex-1 min-w-0">
										<span className="font-medium">{n.name}</span>
										<span className="text-xs text-muted-foreground">
											driver: {n.driver}
											{n.internal ? " · internal" : ""}
											{n.attachable ? " · attachable" : ""}
										</span>
									</div>
								</label>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
