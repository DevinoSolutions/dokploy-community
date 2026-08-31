import {
	formatWildcardBaseDomain,
	normalizeWildcardBaseDomain,
} from "@dokploy/server/utils/wildcard-domain-base";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Globe } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { api } from "@/utils/api";

const wildcardDomainSchema = z.object({
	wildcardDomain: z.string().superRefine((value, ctx) => {
		const result = normalizeWildcardBaseDomain(value);
		if (result.error) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
		}
	}),
});

type WildcardDomainForm = z.infer<typeof wildcardDomainSchema>;

export const WildcardDomain = () => {
	const { data, refetch } = api.organization.getWildcardDomain.useQuery();
	const { mutateAsync, isPending } =
		api.organization.updateWildcardDomain.useMutation();

	const form = useForm<WildcardDomainForm>({
		defaultValues: { wildcardDomain: "" },
		resolver: zodResolver(wildcardDomainSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				wildcardDomain: formatWildcardBaseDomain(data.wildcardDomain),
			});
		}
	}, [form, data]);

	const currentValue = form.watch("wildcardDomain");
	const preview = normalizeWildcardBaseDomain(currentValue);

	const onSubmit = async (formData: WildcardDomainForm) => {
		await mutateAsync({ wildcardDomain: formData.wildcardDomain })
			.then(async () => {
				await refetch();
				toast.success("Wildcard domain saved");
			})
			.catch((error) => {
				toast.error(error?.message ?? "Error saving the wildcard domain");
			});
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<Globe className="size-6 text-muted-foreground self-center" />
								Wildcard Domain
							</CardTitle>
							<CardDescription>
								The base domain Dokploy appends when it generates a domain for a
								service in this organization.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-4 py-6 border-t">
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="wildcardDomain"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Organization wildcard domain</FormLabel>
											<FormControl>
												<Input placeholder="*.apps.example.com" {...field} />
											</FormControl>
											<FormDescription>
												Leave empty to keep the default behaviour (sslip.io, or
												a server's own default domain). A project can override
												this or opt out of it entirely.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								{preview.base && (
									<div className="p-3 bg-muted rounded-lg">
										<span className="text-sm text-muted-foreground">
											Generated domains will look like:{" "}
										</span>
										<span className="font-mono">
											my-app-1a2b3c.{preview.base}
										</span>
									</div>
								)}

								<AlertBlock type="info">
									Point a wildcard DNS record (<code>*.your-base</code>) at this
									server. Each generated domain gets its own Let's Encrypt
									certificate via HTTP-01. A true wildcard certificate requires
									DNS-01 and is not configured automatically.
								</AlertBlock>

								<div className="flex w-full justify-end pt-4">
									<Button isLoading={isPending} type="submit">
										Save
									</Button>
								</div>
							</form>
						</Form>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
