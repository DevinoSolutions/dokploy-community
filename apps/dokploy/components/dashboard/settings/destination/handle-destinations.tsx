import {
	ADDITIONAL_FLAG_ERROR,
	ADDITIONAL_FLAG_REGEX,
	GENERIC_RCLONE_PROVIDER,
} from "@dokploy/server/db/validations/destination";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	ExternalLink,
	KeyRound,
	PenBoxIcon,
	PlusIcon,
	RefreshCw,
	Shield,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { S3_PROVIDERS } from "./constants";

const addDestination = z
	.object({
		name: z.string().min(1, "Name is required"),
		provider: z.string().min(1, "Provider is required"),
		accessKeyId: z.string(),
		secretAccessKey: z.string(),
		bucket: z.string().min(1, "Bucket is required"),
		region: z.string(),
		endpoint: z.string(),
		serverId: z.string().optional(),
		additionalFlags: z
			.array(
				z.object({
					value: z
						.string()
						.min(1, "Flag cannot be empty")
						.regex(ADDITIONAL_FLAG_REGEX, ADDITIONAL_FLAG_ERROR),
				}),
			)
			.optional(),
		// Encryption settings (rclone crypt)
		encryptionEnabled: z.boolean().optional(),
		encryptionKey: z.string().optional(),
		encryptionPassword2: z.string().optional(),
		filenameEncryption: z.enum(["standard", "obfuscate", "off"]).optional(),
		directoryNameEncryption: z.boolean().optional(),
	})
	.superRefine((data, ctx) => {
		const isGenericRclone = data.provider === GENERIC_RCLONE_PROVIDER;

		if (data.encryptionEnabled && !data.encryptionKey?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["encryptionKey"],
				message: "Encryption key is required when encryption is enabled",
			});
		}

		if (!isGenericRclone && !data.accessKeyId.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["accessKeyId"],
				message: "Access Key Id is required",
			});
		}

		if (!isGenericRclone && !data.secretAccessKey.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["secretAccessKey"],
				message: "Secret Access Key is required",
			});
		}

		if (!isGenericRclone && !data.endpoint.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["endpoint"],
				message: "Endpoint is required",
			});
		}
	});

type AddDestination = z.infer<typeof addDestination>;

// Rclone crypt filename encryption options
const FILENAME_ENCRYPTION_OPTIONS = [
	{
		key: "off",
		name: "Off",
		description: "Don't encrypt filenames (recommended for easier management)",
	},
	{
		key: "standard",
		name: "Standard",
		description: "Encrypt filenames using EME encryption",
	},
	{
		key: "obfuscate",
		name: "Obfuscate",
		description: "Simple filename obfuscation (not secure, but hides names)",
	},
] as const;

const generateEncryptionKey = (): string => {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

interface Props {
	destinationId?: string;
}

export const HandleDestinations = ({ destinationId }: Props) => {
	const [open, setOpen] = useState(false);
	const utils = api.useUtils();
	const { data: servers } = api.server.withSSHKey.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const { mutateAsync, isError, error, isPending } = destinationId
		? api.destination.update.useMutation()
		: api.destination.create.useMutation();

	const { data: destination } = api.destination.one.useQuery(
		{
			destinationId: destinationId || "",
		},
		{
			enabled: !!destinationId,
			refetchOnWindowFocus: false,
		},
	);
	const {
		mutateAsync: testConnection,
		isPending: isPendingConnection,
		error: connectionError,
		isError: isErrorConnection,
	} = api.destination.testConnection.useMutation();

	const form = useForm<AddDestination>({
		defaultValues: {
			provider: "",
			accessKeyId: "",
			bucket: "",
			name: "",
			region: "",
			secretAccessKey: "",
			endpoint: "",
			additionalFlags: [],
			encryptionEnabled: false,
			encryptionKey: "",
			encryptionPassword2: "",
			filenameEncryption: "off",
			directoryNameEncryption: false,
		},
		resolver: zodResolver(addDestination),
	});
	const selectedProvider = form.watch("provider");
	const encryptionEnabled = form.watch("encryptionEnabled");
	const filenameEncryption = form.watch("filenameEncryption");

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "additionalFlags",
	});

	const currentProvider = form.watch("provider");
	const isSftpOrFtp = ["sftp", "ftp"].includes(currentProvider || "");

	useEffect(() => {
		if (destination) {
			form.reset({
				name: destination.name,
				provider: destination.provider || "",
				accessKeyId: destination.accessKey,
				secretAccessKey: destination.secretAccessKey,
				bucket: destination.bucket,
				region: destination.region,
				endpoint: destination.endpoint,
				additionalFlags:
					destination.additionalFlags?.map((f) => ({ value: f })) ?? [],
				encryptionEnabled: destination.encryptionEnabled ?? false,
				encryptionKey: destination.encryptionKey ?? "",
				encryptionPassword2: destination.encryptionPassword2 ?? "",
				filenameEncryption:
					(destination.filenameEncryption as
						| "standard"
						| "obfuscate"
						| "off") ?? "off",
				directoryNameEncryption: destination.directoryNameEncryption ?? false,
			});
		} else {
			form.reset();
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, destination]);

	const onSubmit = async (data: AddDestination) => {
		await mutateAsync({
			provider: data.provider || "",
			accessKey: data.accessKeyId,
			bucket: data.bucket,
			endpoint: data.endpoint,
			name: data.name,
			region: data.region,
			secretAccessKey: data.secretAccessKey,
			destinationId: destinationId || "",
			additionalFlags: data.additionalFlags?.map((f) => f.value) ?? [],
			encryptionEnabled: data.encryptionEnabled,
			encryptionKey: data.encryptionKey,
			encryptionPassword2: data.encryptionPassword2,
			filenameEncryption: data.filenameEncryption,
			directoryNameEncryption: data.directoryNameEncryption,
		})
			.then(async () => {
				toast.success(`Destination ${destinationId ? "Updated" : "Created"}`);
				await utils.destination.all.invalidate();
				if (destinationId) {
					await utils.destination.one.invalidate({ destinationId });
				}
				setOpen(false);
			})
			.catch((e) => {
				toast.error(
					`Error ${destinationId ? "Updating" : "Creating"} the Destination`,
					{
						description: e.message,
					},
				);
			});
	};

	const handleTestConnection = async (serverId?: string) => {
		const result = await form.trigger([
			"provider",
			"accessKeyId",
			"secretAccessKey",
			"bucket",
			"endpoint",
			"additionalFlags",
		]);

		if (!result) {
			const errors = form.formState.errors;
			const errorFields = Object.entries(errors)
				.map(([field, error]) => `${field}: ${error?.message}`)
				.filter(Boolean)
				.join("\n");

			toast.error("Please fill all required fields", {
				description: errorFields,
			});
			return;
		}

		if (isCloud && !serverId) {
			toast.error("Please select a server");
			return;
		}

		const provider = form.getValues("provider");
		const accessKey = form.getValues("accessKeyId");
		const secretKey = form.getValues("secretAccessKey");
		const bucket = form.getValues("bucket");
		const endpoint = form.getValues("endpoint");
		const region = form.getValues("region");

		const connectionString =
			provider === GENERIC_RCLONE_PROVIDER
				? bucket
				: isSftpOrFtp
					? `:${provider},host=${endpoint},port=${region || (provider === "sftp" ? "22" : "21")},user=${accessKey},pass=XXX:${bucket}`
					: `:s3,provider=${provider},access_key_id=${accessKey},secret_access_key=${secretKey},endpoint=${endpoint}${region ? `,region=${region}` : ""}:${bucket}`;

		await testConnection({
			provider,
			accessKey,
			bucket,
			endpoint,
			name: "Test",
			region,
			secretAccessKey: secretKey,
			serverId,
			additionalFlags:
				form.getValues("additionalFlags")?.map((f) => f.value) ?? [],
		})
			.then(() => {
				toast.success("Connection Success");
			})
			.catch((e) => {
				toast.error("Error connecting to provider", {
					description: `${e.message}\n\nTry manually: rclone ls ${connectionString}`,
				});
			});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="" asChild>
				{destinationId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10 "
					>
						<PenBoxIcon className="size-3.5  text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Destination
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{destinationId ? "Update" : "Add"} Destination
					</DialogTitle>
					<DialogDescription>
						In this section, you can configure and add new destinations for your
						backups. Please ensure that you provide the correct information to
						guarantee secure and efficient storage.
					</DialogDescription>
				</DialogHeader>
				{(isError || isErrorConnection) && (
					<AlertBlock type="error" className="w-full">
						{connectionError?.message || error?.message}
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form-destination-add"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4 "
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder={"S3 Bucket"} {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Provider</FormLabel>
										<FormControl>
											<Select
												onValueChange={field.onChange}
												defaultValue={field.value}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select a Provider" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{S3_PROVIDERS.map((s3Provider) => (
														<SelectItem
															key={s3Provider.key}
															value={s3Provider.key}
														>
															{s3Provider.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</FormControl>
										<FormMessage />
										{selectedProvider === GENERIC_RCLONE_PROVIDER && (
											<p className="text-xs text-muted-foreground">
												Use a preconfigured rclone remote such as{" "}
												<code>gdrive:backups</code> or <code>ftp:archives</code>
												. Leave S3 credentials blank for this mode.
											</p>
										)}
									</FormItem>
								);
							}}
						/>

						<FormField
							control={form.control}
							name="accessKeyId"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>
											{isSftpOrFtp
												? "Username"
												: selectedProvider === GENERIC_RCLONE_PROVIDER
													? "Access Key Id (optional)"
													: "Access Key Id"}
										</FormLabel>
										<FormControl>
											<Input
												placeholder={isSftpOrFtp ? "username" : "Access Key ID"}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="secretAccessKey"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>
											{isSftpOrFtp
												? "Password"
												: selectedProvider === GENERIC_RCLONE_PROVIDER
													? "Secret Access Key (optional)"
													: "Secret Access Key"}
										</FormLabel>
									</div>
									<FormControl>
										<Input
											type={isSftpOrFtp ? "password" : "text"}
											placeholder={
												isSftpOrFtp ? "password" : "Secret Access Key"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="bucket"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>
											{isSftpOrFtp
												? "Path / Directory"
												: selectedProvider === GENERIC_RCLONE_PROVIDER
													? "Remote path"
													: "Bucket"}
										</FormLabel>
									</div>
									<FormControl>
										<Input
											placeholder={
												isSftpOrFtp
													? "/backups/dokploy"
													: selectedProvider === GENERIC_RCLONE_PROVIDER
														? "gdrive:backups"
														: "dokploy-bucket"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="region"
							render={({ field }) => (
								<FormItem>
									<div className="space-y-0.5">
										<FormLabel>{isSftpOrFtp ? "Port" : "Region"}</FormLabel>
									</div>
									<FormControl>
										<Input
											placeholder={
												isSftpOrFtp
													? currentProvider === "sftp"
														? "22"
														: "21"
													: "us-east-1"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="endpoint"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{isSftpOrFtp
											? "Host"
											: selectedProvider === GENERIC_RCLONE_PROVIDER
												? "Endpoint (optional)"
												: "Endpoint"}
									</FormLabel>
									<FormControl>
										<Input
											placeholder={
												isSftpOrFtp
													? "sftp.example.com"
													: "https://us.bucket.aws/s3"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between">
								<FormLabel>Additional Flags (Optional)</FormLabel>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => append({ value: "" })}
								>
									<PlusIcon className="size-4" />
									Add Flag
								</Button>
							</div>
							{fields.map((field, index) => (
								<FormField
									key={field.id}
									control={form.control}
									name={`additionalFlags.${index}.value`}
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-2">
												<FormControl>
													<Input
														placeholder="--s3-sign-accept-encoding=false"
														{...field}
													/>
												</FormControl>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													onClick={() => remove(index)}
												>
													<Trash2 className="size-4 text-muted-foreground" />
												</Button>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>
							))}
						</div>

						{/* Encryption Settings - Rclone Crypt */}
						<div className="space-y-4 rounded-lg border p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<Shield className="h-4 w-4 text-muted-foreground" />
									<span className="text-sm font-medium">
										Backup Encryption (At Rest)
									</span>
								</div>
								<a
									href="https://rclone.org/crypt/"
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
								>
									<ExternalLink className="h-3 w-3" />
									Rclone Crypt Docs
								</a>
							</div>

							<FormField
								control={form.control}
								name="encryptionEnabled"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
										<div className="space-y-0.5">
											<FormLabel>Enable Encryption</FormLabel>
											<FormDescription>
												Encrypt backups using NaCl SecretBox (XSalsa20 +
												Poly1305). Supported for S3 and generic rclone
												destinations.
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

							{encryptionEnabled && (
								<>
									{/* Main Password */}
									<FormField
										control={form.control}
										name="encryptionKey"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Password (Required)</FormLabel>
												<div className="flex gap-2">
													<FormControl>
														<Input
															type="password"
															placeholder="Enter or generate a password"
															{...field}
														/>
													</FormControl>
													<Button
														type="button"
														variant="outline"
														size="icon"
														onClick={() => {
															const key = generateEncryptionKey();
															form.setValue("encryptionKey", key);
															toast.success("Password generated", {
																description:
																	"Make sure to save this password securely.",
															});
														}}
													>
														<RefreshCw className="h-4 w-4" />
													</Button>
												</div>
												<FormDescription>
													<KeyRound className="mr-1 inline h-3 w-3" />
													Main encryption password. Store securely - lost
													passwords cannot be recovered.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>

									{/* Salt Password (Password2) */}
									<FormField
										control={form.control}
										name="encryptionPassword2"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Salt Password (Recommended)</FormLabel>
												<div className="flex gap-2">
													<FormControl>
														<Input
															type="password"
															placeholder="Optional but recommended"
															{...field}
														/>
													</FormControl>
													<Button
														type="button"
														variant="outline"
														size="icon"
														onClick={() => {
															const key = generateEncryptionKey();
															form.setValue("encryptionPassword2", key);
															toast.success("Salt password generated", {
																description:
																	"Make sure to save this password securely.",
															});
														}}
													>
														<RefreshCw className="h-4 w-4" />
													</Button>
												</div>
												<FormDescription>
													Additional salt for extra security. Should be
													different from the main password.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>

									{/* Filename Encryption */}
									<FormField
										control={form.control}
										name="filenameEncryption"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Filename Encryption</FormLabel>
												<FormControl>
													<Select
														onValueChange={field.onChange}
														value={field.value}
													>
														<SelectTrigger>
															<SelectValue placeholder="Select filename encryption" />
														</SelectTrigger>
														<SelectContent>
															{FILENAME_ENCRYPTION_OPTIONS.map((option) => (
																<SelectItem key={option.key} value={option.key}>
																	<div className="flex flex-col">
																		<span>{option.name}</span>
																		<span className="text-xs text-muted-foreground">
																			{option.description}
																		</span>
																	</div>
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</FormControl>
												<FormDescription>
													Choose how backup filenames should be encrypted.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>

									{/* Directory Name Encryption (only shown when filename encryption is not off) */}
									{filenameEncryption && filenameEncryption !== "off" && (
										<FormField
											control={form.control}
											name="directoryNameEncryption"
											render={({ field }) => (
												<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
													<div className="space-y-0.5">
														<FormLabel>Encrypt Directory Names</FormLabel>
														<FormDescription>
															Also encrypt directory/folder names
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
									)}
								</>
							)}
						</div>
					</form>

					<DialogFooter
						className={cn(
							isCloud ? "flex-col!" : "flex-row",
							"flex w-full  justify-between! gap-4",
						)}
					>
						{isCloud ? (
							<div className="flex flex-col gap-4 border p-2 rounded-lg">
								<span className="text-sm text-muted-foreground">
									Select a server to test the destination. If you don't have a
									server choose the default one.
								</span>
								<FormField
									control={form.control}
									name="serverId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Server (Optional)</FormLabel>
											<FormControl>
												<Select
													onValueChange={field.onChange}
													defaultValue={field.value}
												>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a server" />
													</SelectTrigger>
													<SelectContent>
														<SelectGroup>
															<SelectLabel>Servers</SelectLabel>
															{servers?.map((server) => (
																<SelectItem
																	key={server.serverId}
																	value={server.serverId}
																>
																	{server.name}
																</SelectItem>
															))}
															<SelectItem value={"none"}>None</SelectItem>
														</SelectGroup>
													</SelectContent>
												</Select>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
								<Button
									type="button"
									variant={"secondary"}
									isLoading={isPendingConnection}
									onClick={async () => {
										await handleTestConnection(form.getValues("serverId"));
									}}
								>
									Test Connection
								</Button>
							</div>
						) : (
							<Button
								isLoading={isPendingConnection}
								type="button"
								variant="secondary"
								onClick={async () => {
									await handleTestConnection();
								}}
							>
								Test connection
							</Button>
						)}

						<Button
							isLoading={isPending}
							form="hook-form-destination-add"
							type="submit"
						>
							{destinationId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
