import { Globe, Layers } from "lucide-react";
import {
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";

// Service types surfaced across the Backup Center (policies + coverage table).
export type BackupServiceType =
	| "application"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "libsql"
	| "redis"
	| "compose";

export const SERVICE_TYPE_LABELS: Record<BackupServiceType, string> = {
	application: "Application",
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	libsql: "LibSQL",
	redis: "Redis",
	compose: "Compose",
};

interface Props {
	type: BackupServiceType;
	className?: string;
}

export const ServiceTypeIcon = ({ type, className = "size-4" }: Props) => {
	switch (type) {
		case "postgres":
			return <PostgresqlIcon className={className} />;
		case "mysql":
			return <MysqlIcon className={className} />;
		case "mariadb":
			return <MariadbIcon className={className} />;
		case "mongo":
			return <MongodbIcon className={className} />;
		case "libsql":
			return <LibsqlIcon className={className} />;
		case "redis":
			return <RedisIcon className={className} />;
		case "compose":
			return <Layers className={`${className} text-muted-foreground`} />;
		default:
			return <Globe className={`${className} text-muted-foreground`} />;
	}
};
