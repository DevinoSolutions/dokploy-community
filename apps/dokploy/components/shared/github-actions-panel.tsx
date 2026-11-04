import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** The hint under the deploy button of a service that GitHub Actions builds. */
export const GithubActionsRedeployHint = ({
	target,
}: {
	target?: string | null;
}) => (
	<p className="text-sm text-muted-foreground">
		To build a new version, push to {target || "your repository"}; GitHub
		Actions deploys it.
	</p>
);

interface AdvancedProps {
	description: string;
	children: ReactNode;
}

/**
 * Keeps the raw image or compose editor (and the other source options) one click away, closed by default, so the
 * primary view of a GitHub Actions service stays about what is running and where it came from.
 */
export const GithubActionsAdvanced = ({
	description,
	children,
}: AdvancedProps) => {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-lg border bg-background"
		>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex w-full items-center justify-between gap-4 rounded-lg px-6 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="flex flex-col gap-0.5">
						<span className="font-medium">Advanced</span>
						<span className="text-sm text-muted-foreground">{description}</span>
					</span>
					<ChevronDown
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-180",
						)}
					/>
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col gap-4 border-t p-4">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
};
