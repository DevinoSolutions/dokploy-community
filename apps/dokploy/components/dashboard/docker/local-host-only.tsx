import { Card } from "@/components/ui/card";

// The Dokploy host serves every organization of the instance, so the others
// see this instead of its Docker data.
export const LOCAL_HOST_ONLY_MESSAGE =
	"Only the organization that owns this instance can see the Dokploy host here.";

// The Containers tab lists the caller's own services on the host too, so when
// it is empty it says what the host is rather than that it is closed.
export const LOCAL_HOST_EMPTY_CONTAINERS_MESSAGE =
	"This is the Dokploy host. Only the organization that owns the instance sees all of it. Containers of your own services on this host appear here.";

export const LocalHostOnlyNotice = () => (
	<Card className="h-full bg-sidebar p-2.5 rounded-xl mx-auto w-full">
		<div className="rounded-xl bg-background shadow-md p-6 text-sm text-muted-foreground">
			{LOCAL_HOST_ONLY_MESSAGE}
		</div>
	</Card>
);
