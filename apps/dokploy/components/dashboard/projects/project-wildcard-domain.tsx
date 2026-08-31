import {
	formatWildcardBaseDomain,
	normalizeWildcardBaseDomain,
} from "@dokploy/server/utils/wildcard-domain-base";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const schema = z.object({
	wildcardDomain: z.string().superRefine((value, ctx) => {
		const result = normalizeWildcardBaseDomain(value);
		if (result.error) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
		}
	}),
	useOrganizationWildcard: z.boolean(),
});

type ProjectWildcardDomainForm = z.infer<typeof schema>;

const SOURCE_LABEL: Record<string, string> = {
	project: "this project's override",
	server: "the service's server default domain",
	organization: "the organization wildcard domain",
	environment: "the DEFAULT_DOMAIN environment variable",
	none: "no wildcard base (sslip.io will be used)",
};

interface Props {
	projectId: string;
	children?: React.ReactNode;
}

export const ProjectWildcardDomain = ({ projectId, children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const utils = api.useUtils();
	const { data, refetch } = api.project.getWildcardDomainConfig.useQuery(
		{ projectId },
		{ enabled: !!projectId && isOpen, retry: false },
	);
	const { mutateAsync, isPending } =
		api.project.updateWildcardDomain.useMutation();

	const form = useForm<ProjectWildcardDomainForm>({
		defaultValues: { wildcardDomain: "", useOrganizationWildcard: true },
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				wildcardDomain: formatWildcardBaseDomain(data.wildcardDomain),
				useOrganizationWildcard: data.useOrganizationWildcard,
			});
		}
	}, [form, data]);

	const wildcardDomain = form.watch("wildcardDomain");
	const useOrganizationWildcard = form.watch("useOrganizationWildcard");
	const parsed = normalizeWildcardBaseDomain(wildcardDomain);

	// Mirrors `resolveGeneratedDomainBase` for the rungs the client can see. The
	// server stays authoritative — `effectiveBaseDomain` below is what it
	// actually resolved for this project.
	const previewBase =
		parsed.base ??
		(useOrganizationWildcard ? (data?.organizationWildcardDomain ?? null) : null);

	const onSubmit = async (formData: ProjectWildcardDomainForm) => {
		await mutateAsync({
			projectId,
			wildcardDomain: formData.wildcardDomain,
			useOrganizationWildcard: formData.useOrganizationWildcard,
		})
			.then(async () => {
				await refetch();
				utils.project.all.invalidate();
				toast.success("Wildcard domain updated");
			})
			.catch((error) => {
				toast.error(error?.message ?? "Error updating the wildcard domain");
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						onSelect={(e) => e.preventDefault()}
					>
						<Globe className="size-4" />
						<span>Wildcard Domain</span>
					</DropdownMenuItem>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Wildcard Domain</DialogTitle>
					<DialogDescription>
						Choose the base domain Dokploy appends when it generates a domain for
						a service in this project.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="wildcardDomain"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Project wildcard domain</FormLabel>
									<FormControl>
										<Input placeholder="*.apps.example.com" {...field} />
									</FormControl>
									<FormDescription>
										Overrides everything else for this project. Leave empty to
										inherit.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="useOrganizationWildcard"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-sm">
									<div className="space-y-0.5">
										<FormLabel>Use organization wildcard domain</FormLabel>
										<FormDescription>
											{data?.organizationWildcardDomain
												? `Falls back to *.${data.organizationWildcardDomain} when this project has no override.`
												: "No organization wildcard domain is configured yet (Settings → Server)."}
										</FormDescription>
										<FormMessage />
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<div className="p-3 bg-muted rounded-lg space-y-1">
							<div>
								<span className="text-sm text-muted-foreground">
									Effective base (saved):{" "}
								</span>
								<span className="font-mono">
									{data?.effectiveBaseDomain
										? `*.${data.effectiveBaseDomain}`
										: "sslip.io fallback"}
								</span>
							</div>
							{data?.effectiveSource && (
								<p className="text-xs text-muted-foreground">
									Resolved from {SOURCE_LABEL[data.effectiveSource]}.
								</p>
							)}
							{previewBase && (
								<div>
									<span className="text-sm text-muted-foreground">
										Preview after saving:{" "}
									</span>
									<span className="font-mono">
										my-app-1a2b3c.{previewBase}
									</span>
								</div>
							)}
						</div>

						<AlertBlock type="info">
							A service that runs on a remote server with its own default domain
							keeps using that domain — only the project override outranks it.
							Point a wildcard DNS record (<code>*.your-base</code>) at the
							server. Each generated domain gets its own Let's Encrypt
							certificate via HTTP-01. A true wildcard certificate requires
							DNS-01 and is not configured automatically.
						</AlertBlock>

						<DialogFooter>
							<Button isLoading={isPending} type="submit">
								Save
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
