import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

const hourToCron = (hour: number) => `0 ${hour} * * *`;

const options = Array.from({ length: 24 }, (_, hour) => ({
	value: hourToCron(hour),
	label: `${String(hour).padStart(2, "0")}:00 UTC`,
}));

interface Props {
	/** The stored `dockerCleanupCron`. */
	value: string;
	onChange: (cron: string) => void;
	disabled?: boolean;
}

/**
 * Picks the hour (UTC) of the daily Docker cleanup. A schedule set through the
 * API that is not on the hour of every day (for example a weekly one) is shown
 * as it is and kept until another hour is picked.
 */
export const DockerCleanupScheduleSelect = ({
	value,
	onChange,
	disabled,
}: Props) => {
	const items = options.some((option) => option.value === value)
		? options
		: [...options, { value, label: `Custom: ${value} (UTC)` }];

	return (
		<Select value={value} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger className="w-48">
				<SelectValue placeholder="Select a time" />
			</SelectTrigger>
			<SelectContent>
				{items.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};
