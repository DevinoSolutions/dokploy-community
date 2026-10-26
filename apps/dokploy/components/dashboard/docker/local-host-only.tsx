import { Card } from "@/components/ui/card";

// The Dokploy host serves every organization of the instance, so the others
// see this instead of its Docker data.
export const LocalHostOnlyNotice = () => (
	<Card className="h-full bg-sidebar p-2.5 rounded-xl mx-auto w-full">
		<div className="rounded-xl bg-background shadow-md p-6 text-sm text-muted-foreground">
			Only the organization that owns this instance can see the Dokploy host
			here.
		</div>
	</Card>
);
