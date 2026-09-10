import { ListChecks, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

export const ShowRequiredChecks = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { mutateAsync, isPending } = api.application.update.useMutation();

	const [checks, setChecks] = useState<string[]>([]);
	const [newCheck, setNewCheck] = useState("");

	useEffect(() => {
		if (data) {
			setChecks(data.requiredChecks ?? []);
		}
	}, [data]);

	const addCheck = () => {
		const check = newCheck.trim();
		if (!check) return;
		if (checks.includes(check)) {
			toast.error("Check already exists");
			return;
		}
		setChecks([...checks, check]);
		setNewCheck("");
	};

	const removeCheck = (check: string) => {
		setChecks(checks.filter((value) => value !== check));
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addCheck();
		}
	};

	const onSubmit = async () => {
		await mutateAsync({
			applicationId,
			requiredChecks: checks,
		})
			.then(async () => {
				toast.success("Required Checks Updated");
				await refetch();
			})
			.catch(() => {
				toast.error("Error updating required checks");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex flex-row items-center gap-2">
					<ListChecks className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">Required Checks</CardTitle>
						<CardDescription>
							An empty list leaves the deploy ungated. With one or more names,
							the deploy waits for those GitHub check runs on the commit to
							succeed before it continues. Legacy commit-status contexts are
							accepted too, so either a check-run name or a status context works
							here.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex gap-2">
					<Input
						placeholder="build"
						value={newCheck}
						onChange={(e) => setNewCheck(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					<Button type="button" variant="secondary" onClick={addCheck}>
						<Plus className="size-4" />
						Add
					</Button>
				</div>

				{checks.length > 0 ? (
					<div className="flex flex-wrap gap-2">
						{checks.map((check) => (
							<Badge
								key={check}
								variant="secondary"
								className="text-sm py-1 px-3 gap-1"
							>
								{check}
								<button
									type="button"
									onClick={() => removeCheck(check)}
									className="ml-1 hover:text-destructive"
								>
									<X className="size-3" />
								</button>
							</Badge>
						))}
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						No required checks configured. Deploys of this application are not
						gated on GitHub check runs.
					</p>
				)}

				<div className="flex w-full justify-end">
					<Button isLoading={isPending} type="button" onClick={onSubmit}>
						Save
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
