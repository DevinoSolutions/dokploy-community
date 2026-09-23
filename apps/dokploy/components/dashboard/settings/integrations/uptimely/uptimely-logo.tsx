import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export const UPTIMELY_SITE_URL = "https://getuptimely.com";

export const UptimelyMark = ({ className }: { className?: string }) => (
	<span
		className={cn(
			"inline-flex items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
			className,
		)}
	>
		<Activity className="size-[60%]" />
	</span>
);

export const PoweredByUptimely = ({ className }: { className?: string }) => (
	<div
		className={cn(
			"flex items-center justify-end gap-1 text-xs text-muted-foreground",
			className,
		)}
	>
		<span>Powered by</span>
		<a
			href={UPTIMELY_SITE_URL}
			target="_blank"
			rel="noopener noreferrer"
			className="font-medium text-foreground hover:underline"
		>
			Uptimely
		</a>
	</div>
);
