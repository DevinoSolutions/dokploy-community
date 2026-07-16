import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { GlobeIcon, PenBoxIcon, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { Dropzone } from "@/components/ui/dropzone";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { processImageUpload } from "@/lib/image-upload";
import { api } from "@/utils/api";

const organizationSchema = z.object({
	name: z.string().min(1, {
		message: "Organization name is required",
	}),
	logo: z.string().optional(),
	description: z.string().max(280).optional(),
});

const getOrganizationDescription = (metadata?: string | null) => {
	if (!metadata) {
		return "";
	}

	try {
		const parsed = JSON.parse(metadata);
		return typeof parsed?.description === "string" ? parsed.description : "";
	} catch {
		return "";
	}
};

type OrganizationFormValues = z.infer<typeof organizationSchema>;

interface Props {
	organizationId?: string;
	children?: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function AddOrganization({
	organizationId,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
}: Props) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = isControlled ? controlledOnOpenChange! : setInternalOpen;
	const utils = api.useUtils();
	const { data: organization } = api.organization.one.useQuery(
		{
			organizationId: organizationId ?? "",
		},
		{
			enabled: !!organizationId,
		},
	);
	const { mutateAsync, isPending } = organizationId
		? api.organization.update.useMutation()
		: api.organization.create.useMutation();

	const form = useForm<OrganizationFormValues>({
		resolver: zodResolver(organizationSchema),
		defaultValues: {
			name: "",
			logo: "",
			description: "",
		},
	});

	useEffect(() => {
		if (organization) {
			form.reset({
				name: organization.name,
				logo: organization.logo || "",
				description: getOrganizationDescription(organization.metadata),
			});
			setUploadedFileName(null);
		}
	}, [organization, form]);

	const onSubmit = async (values: OrganizationFormValues) => {
		await mutateAsync({
			name: values.name,
			logo: values.logo,
			description: values.description,
			organizationId: organizationId ?? "",
		})
			.then(() => {
				form.reset();
				setUploadedFileName(null);
				toast.success(
					`Organization ${organizationId ? "updated" : "created"} successfully`,
				);
				utils.organization.all.invalidate();
				if (organizationId) {
					utils.organization.one.invalidate({ organizationId });
					utils.organization.active.invalidate();
				}
				setOpen(false);
			})
			.catch((error) => {
				console.error(error);
				toast.error(
					error?.message ??
						`Failed to ${organizationId ? "update" : "create"} organization`,
				);
			});
	};

	const handleFileUpload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const file = files[0];
		if (!file) return;

		const result = await processImageUpload(file);
		if (!result.ok) {
			toast.error(result.error);
			return;
		}

		form.setValue("logo", result.dataUrl);
		form.trigger("logo");
		setUploadedFileName(file.name);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{!isControlled && (
				<DialogTrigger asChild>
					{organizationId ? (
						<DropdownMenuItem
							className="group cursor-pointer hover:bg-blue-500/10"
							onSelect={(e) => e.preventDefault()}
						>
							<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							className="gap-2 p-2"
							onSelect={(e) => e.preventDefault()}
						>
							<div className="flex size-6 items-center justify-center rounded-md border bg-background">
								<Plus className="size-4" />
							</div>
							<div className="font-medium text-muted-foreground">
								Add organization
							</div>
						</DropdownMenuItem>
					)}
				</DialogTrigger>
			)}
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>
						{organizationId ? "Update organization" : "Add organization"}
					</DialogTitle>
					<DialogDescription>
						{organizationId
							? "Update the organization name, logo, and description"
							: "Create a new organization to manage your projects."}
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid gap-4 py-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem className="tems-center gap-4">
									<FormLabel className="text-right">Name</FormLabel>
									<FormControl>
										<Input
											placeholder="Organization name"
											{...field}
											className="col-span-3"
										/>
									</FormControl>
									<FormMessage className="" />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="logo"
							render={({ field }) => {
								const isDataUrl = field.value?.startsWith("data:");
								const displayValue = isDataUrl
									? uploadedFileName || "Uploaded image"
									: field.value || "";

								return (
									<FormItem className="gap-4">
										<FormLabel className="text-right">
											Logo URL or Upload
										</FormLabel>
										<FormControl>
											<div className="col-span-3 flex flex-col gap-3">
												<div className="flex items-center gap-3">
													<div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/50 p-1">
														{field.value ? (
															// biome-ignore lint/performance/noImgElement: user uploaded logo preview
															<img
																src={field.value}
																alt="Logo preview"
																className="size-full object-contain"
															/>
														) : (
															<GlobeIcon className="size-5 text-muted-foreground" />
														)}
													</div>
													<div className="relative flex-1">
														<Input
															placeholder="https://example.com/logo.png"
															{...field}
															value={displayValue}
															readOnly={isDataUrl}
															onChange={(e) => {
																field.onChange(e);
																if (isDataUrl) setUploadedFileName(null);
															}}
															className="w-full pr-8"
														/>
														{field.value && (
															<button
																type="button"
																onClick={() => {
																	form.setValue("logo", "");
																	setUploadedFileName(null);
																}}
																className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
															>
																<X className="size-4" />
															</button>
														)}
													</div>
												</div>
												<Dropzone
													dropMessage="Drag & drop a logo or click to upload"
													accept=".jpg,.jpeg,.png,.svg,.webp,image/jpeg,image/png,image/svg+xml,image/webp"
													onChange={handleFileUpload}
													classNameWrapper="border-2 border-dashed border-border hover:border-primary bg-muted/30 hover:bg-muted/50 transition-all rounded-lg"
													classNameContent="h-32"
												/>
											</div>
										</FormControl>
										<FormMessage className="col-span-3 col-start-2" />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem className="gap-4">
									<FormLabel className="text-right">Description</FormLabel>
									<FormControl>
										<Input
											placeholder="What this organization is for"
											{...field}
											value={field.value || ""}
											className="col-span-3"
										/>
									</FormControl>
									<FormMessage className="col-span-3 col-start-2" />
								</FormItem>
							)}
						/>
						<DialogFooter>
							<Button type="submit" isLoading={isPending}>
								{organizationId ? "Update organization" : "Create organization"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
