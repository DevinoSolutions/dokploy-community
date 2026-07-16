import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

const schema = z.object({
	pullImagesOnDeploy: z.boolean().optional(),
});

type Schema = z.infer<typeof schema>;

export const PullImagesCompose = ({ composeId }: Props) => {
	const { mutateAsync } = api.compose.update.useMutation();
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);

	const form = useForm<Schema>({
		defaultValues: { pullImagesOnDeploy: false },
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({ pullImagesOnDeploy: data.pullImagesOnDeploy ?? false });
		}
	}, [form, data]);

	const onSubmit = async (formData: Schema) => {
		await mutateAsync({
			composeId,
			pullImagesOnDeploy: formData.pullImagesOnDeploy ?? false,
		})
			.then(async () => {
				await refetch();
				toast.success("Compose updated");
			})
			.catch(() => {
				toast.error("Error updating the compose");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Pull Latest Images</CardTitle>
				<CardDescription>
					When enabled, the latest images are pulled before every deployment
					(<code>docker compose up --pull always</code>), so a redeploy picks up
					updated tags instead of reusing the local cache. Only applies to the
					Docker Compose deploy type.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						id="pull-images-form"
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="pullImagesOnDeploy"
							render={({ field }) => (
								<FormItem className="mt-4 flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
									<div className="space-y-0.5">
										<FormLabel>Pull latest images on deploy</FormLabel>
										<FormDescription>
											Force-pull updated images before each deployment.
										</FormDescription>
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
						<div className="flex w-full items-end justify-end">
							<Button
								form="pull-images-form"
								type="submit"
								className="lg:w-fit"
								isLoading={form.formState.isSubmitting}
							>
								Save
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
