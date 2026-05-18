CREATE UNIQUE INDEX IF NOT EXISTS "network_name_serverId_idx" ON "network" USING btree ("name", COALESCE("serverId", ''));
