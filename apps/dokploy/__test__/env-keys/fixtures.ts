/** Every value below starts with SECRET- so a test can grep a reply for leaks. */
export const SECRET_MARK = "SECRET-";

export const secretApplicationRow = () => ({
	applicationId: "app-1",
	name: "Web",
	appName: "web-abc",
	sourceType: "docker",
	env: "API_KEY=SECRET-env-api\nPLAIN=ok",
	buildArgs: "NPM_TOKEN=SECRET-build-arg",
	buildSecrets: "GH_PAT=SECRET-build-secret",
	previewEnv: "API_KEY=SECRET-preview-env",
	previewBuildArgs: "A=SECRET-preview-arg",
	previewBuildSecrets: "B=SECRET-preview-secret",
	username: "deploy-user",
	password: "SECRET-docker-password",
	refreshToken: "SECRET-refresh-token",
	customGitUrl: "https://ci:SECRET-url-token@git.example.com/org/repo.git",
	customGitSSHKeyId: "ssh-1",
	customGitSSHKey: {
		sshKeyId: "ssh-1",
		name: "deploy key",
		privateKey: "SECRET-ssh-private-key",
		publicKey: "ssh-ed25519 AAAA-public",
	},
	environment: {
		environmentId: "env-1",
		name: "production",
		env: "ENV_LEVEL=SECRET-environment-env",
		project: {
			projectId: "proj-1",
			organizationId: "org-1",
			env: "PROJECT_LEVEL=SECRET-project-env",
		},
	},
	server: {
		serverId: "srv-1",
		name: "edge",
		metricsConfig: {
			server: {
				type: "Remote",
				port: 4500,
				token: "SECRET-metrics-token",
				refreshRate: 60,
			},
			containers: { refreshRate: 60 },
		},
	},
	security: [
		{ securityId: "sec-1", username: "admin", password: "SECRET-basic" },
	],
	github: {
		githubId: "gh-1",
		githubAppName: "my-app",
		githubClientSecret: "SECRET-gh-client",
		githubPrivateKey: "SECRET-gh-key",
		githubWebhookSecret: "SECRET-gh-hook",
	},
	gitlab: {
		gitlabId: "gl-1",
		secret: "SECRET-gl-secret",
		accessToken: "SECRET-gl-access",
		refreshToken: "SECRET-gl-refresh",
	},
	bitbucket: {
		bitbucketId: "bb-1",
		appPassword: "SECRET-bb-password",
		apiToken: "SECRET-bb-token",
	},
	gitea: {
		giteaId: "gt-1",
		clientSecret: "SECRET-gt-secret",
		accessToken: "SECRET-gt-access",
		refreshToken: "SECRET-gt-refresh",
	},
	registry: {
		registryId: "reg-1",
		registryUrl: "r.example.com",
		password: "SECRET-reg",
	},
	buildRegistry: { registryId: "reg-2", password: "SECRET-build-reg" },
	rollbackRegistry: { registryId: "reg-3", password: "SECRET-rollback-reg" },
	domains: [{ domainId: "d-1", host: "web.example.com" }],
	ports: [{ portId: "p-1", publishedPort: 8080 }],
});

export const secretComposeRow = () => ({
	composeId: "comp-1",
	name: "Stack",
	appName: "stack-abc",
	sourceType: "raw",
	env: "DB_PASSWORD=SECRET-compose-env",
	previewEnv: "DB_PASSWORD=SECRET-compose-preview",
	refreshToken: "SECRET-compose-refresh",
	composeFile: "services:\n  web:\n    image: nginx\n",
	environment: {
		environmentId: "env-1",
		env: "X=SECRET-compose-environment-env",
		project: {
			projectId: "proj-1",
			organizationId: "org-1",
			env: "Y=SECRET-compose-project-env",
		},
	},
	buildServer: { serverId: "b-1", name: "builder" },
	backups: [
		{
			backupId: "bk-1",
			schedule: "0 0 * * *",
			destination: {
				destinationId: "dest-1",
				name: "b2",
				bucket: "backups",
				encryptionEnabled: true,
				encryptionKey: "SECRET-crypt-key",
				encryptionPassword2: "SECRET-crypt-salt",
			},
			metadata: {
				mariadb: { databaseUser: "u", databasePassword: "SECRET-meta-pass" },
				mysql: { databaseRootPassword: "SECRET-meta-root" },
			},
		},
	],
});

export const secretPostgresRow = () => ({
	postgresId: "pg-1",
	name: "DB",
	appName: "db-abc",
	databaseUser: "app",
	databasePassword: "SECRET-db-pass",
	env: "POSTGRES_EXTRA=SECRET-db-env",
	environment: {
		environmentId: "env-1",
		env: "",
		project: { projectId: "proj-1", organizationId: "org-1", env: "" },
	},
});
