import { exit } from "node:process";
import { setupDirectories } from "@dokploy/server/setup/config-paths";
import { initializePostgres } from "@dokploy/server/setup/postgres-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@dokploy/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	ensureTraefikImage,
	initializeStandaloneTraefik,
	initializeTraefikService,
} from "@dokploy/server/setup/traefik-setup";

const useTraefikSwarmMode = process.env.TRAEFIK_SWARM_MODE === "true";

(async () => {
	try {
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		if (useTraefikSwarmMode) {
			// The standalone path pulls the image itself.
			await ensureTraefikImage();
			await initializeTraefikService({});
		} else {
			await initializeStandaloneTraefik();
		}
		await initializePostgres();
		console.log("Dokploy setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in dokploy setup", e);
	}
})();
