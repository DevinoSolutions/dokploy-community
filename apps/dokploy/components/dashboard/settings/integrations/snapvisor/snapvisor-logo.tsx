import { ScanEye } from "lucide-react";
import { cn } from "@/lib/utils";

export const SNAPVISOR_SITE_URL = "https://snapvisor.io";

export const SnapvisorMark = ({ className }: { className?: string }) => (
	<span
		className={cn(
			"inline-flex items-center justify-center rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400",
			className,
		)}
	>
		<ScanEye className="size-[60%]" />
	</span>
);

export const PoweredBySnapvisor = ({ className }: { className?: string }) => (
	<div
		className={cn(
			"flex items-center justify-end gap-1 text-xs text-muted-foreground",
			className,
		)}
	>
		<span>Visual testing by</span>
		<a
			href={SNAPVISOR_SITE_URL}
			target="_blank"
			rel="noopener noreferrer"
			className="font-medium text-foreground hover:underline"
		>
			Snapvisor
		</a>
	</div>
);
