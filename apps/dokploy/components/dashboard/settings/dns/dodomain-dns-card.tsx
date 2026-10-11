import Link from "next/link";
import { LearnMoreLink } from "@/components/shared/learn-more-link";
import { Badge } from "@/components/ui/badge";
import { api } from "@/utils/api";
import { INTEGRATION_LEARN_MORE_URLS } from "../integrations/integration-links";
import { DoDomainMark } from "../integrations/dodomain/dodomain-logo";

export const DODOMAIN_INTEGRATION_SETTINGS_URL =
	"/dashboard/settings/integrations";

/**
 * Explainer for people who look for DoDomain among the DNS providers. It is
 * deliberately not a provider: DoDomain has no zone or record management, it
 * sends the owner of a domain you do not control a link to approve the DNS
 * records at their own registrar. Only whether it is configured is read (the
 * key never reaches this page), and the settings link is shown to the roles
 * that may open that page (owners and admins), so it never leads to a redirect.
 */
export const DoDomainDnsCard = () => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: configuredData } = api.dodomain.configured.useQuery();
	const { data: user } = api.user.get.useQuery();

	// Self-hosted only, like the integration itself.
	if (isCloud) return null;

	const configured = configuredData?.configured ?? false;
	const canOpenSettings = user?.role === "owner" || user?.role === "admin";

	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
			<div className="flex flex-row items-start gap-3">
				<DoDomainMark className="size-10 shrink-0" />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-row flex-wrap items-center gap-2">
						<span className="text-base font-medium">DoDomain</span>
						{configuredData && (
							<Badge variant={configured ? "default" : "outline"}>
								{configured ? "Configured" : "Not connected"}
							</Badge>
						)}
					</div>
					<span className="text-sm text-muted-foreground">
						DoDomain is not a DNS provider. Use it for a domain you do not
						control, such as a customer&apos;s: it sends the owner a link to
						approve the DNS records at their own registrar, and Dokploy then
						tracks the verification, checking its status automatically.
					</span>
					<span className="text-sm text-muted-foreground">
						You send the link from an app&apos;s Domains tab, not from this
						page.
					</span>
				</div>
			</div>
			<div className="flex flex-row flex-wrap items-center justify-between gap-2">
				{canOpenSettings ? (
					<Link
						href={DODOMAIN_INTEGRATION_SETTINGS_URL}
						className="text-sm font-medium underline-offset-4 hover:underline"
					>
						{configured
							? "Manage DoDomain in Integrations"
							: "Connect DoDomain in Integrations"}
					</Link>
				) : (
					<span className="text-xs text-muted-foreground">
						An organization admin can {configured ? "manage" : "connect"}{" "}
						DoDomain in Settings → Integrations.
					</span>
				)}
				<LearnMoreLink href={INTEGRATION_LEARN_MORE_URLS.dodomain} />
			</div>
		</div>
	);
};
