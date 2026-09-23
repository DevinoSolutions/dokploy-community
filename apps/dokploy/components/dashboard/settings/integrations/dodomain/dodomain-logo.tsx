import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export const DODOMAIN_SITE_URL = "https://dodomain.io";

export const DoDomainMark = ({ className }: { className?: string }) => (
	<span
		className={cn(
			"inline-flex items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400",
			className,
		)}
	>
		<Globe className="size-[60%]" />
	</span>
);

export const PoweredByDoDomain = ({ className }: { className?: string }) => (
	<div
		className={cn(
			"flex items-center justify-end gap-1 text-xs text-muted-foreground",
			className,
		)}
	>
		<span>Domain connect by</span>
		<a
			href={DODOMAIN_SITE_URL}
			target="_blank"
			rel="noopener noreferrer"
			className="font-medium text-foreground hover:underline"
		>
			DoDomain
		</a>
	</div>
);
