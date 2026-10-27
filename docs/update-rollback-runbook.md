# Dokploy Community update rollback runbook

How to put a Dokploy Community instance back on a previous version after an
update, and how to decide whether the database needs to go back too. It applies
to any release; replace the placeholders with your own values.

Placeholders: `<previous-digest>` is the image index digest of the version you
are going back to (`sha256:...`), `<previous-tag>` and `<new-tag>` are release
tags such as `v0.30.8-community.NN`.

Related: [build-once rollout runbook](build-once-rollout-runbook.md) (pre-flight
backups, §2), [off-canary hotfix runbook](off-canary-hotfix-runbook.md).

## 1. Rules

- **Roll back by digest, never by tag.** Tags such as `:latest` and `:canary`
  move on every push. A digest names exactly one image.
- **Never update, roll back or restart Dokploy while the deploy queue has
  jobs.** Check that the queue is empty, wait a moment, and check again: two
  empty checks in a row.
- **Take a `pg_dump` before any update or rollback**, and write down the digest
  of the running image. Both are covered in
  [§2.1 and §2.2 of the rollout runbook](build-once-rollout-runbook.md).
- Do not touch the `dokploy-traefik`, `dokploy-postgres` or `dokploy-redis`
  services. A rollback changes the `dokploy` service only.

## 2. Are the migrations additive?

An image-only rollback leaves the database as the newer version migrated it.
That is safe only when the older code can live with the extra schema. Compare
the migrations the two releases ship:

```
git diff <previous-tag> <new-tag> -- apps/dokploy/drizzle
```

Judge each new `.sql` file:

| What the diff shows | Image-only rollback |
| --- | --- |
| New tables, new nullable columns, new columns with a default, `CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, new indexes | Safe. The old code never queries them, and its migrator only applies entries in its own journal, so it does not try to undo them. |
| `DROP`, `RENAME`, a column type change, a new `NOT NULL` without a default, or statements that rewrite or delete data | Not safe. Restore the backup taken before the update instead (§5). |

If the diff is empty, the update had no migrations and the image can be switched
freely. The release PR body records which case applies, and the release's
CHANGELOG entry carries an upgrade note.

## 3. In-app rollback

Settings → Update Server shows what an update does before you start it.

- **Migrations.** For the latest version, for a pinned release tag you type in,
  and for the rollback target, the dialog lists the database migrations the
  target applies compared with the running version, for example "This update
  applies 1 database migration: 0224_name". It also warns that rolling back only
  switches the image and does not undo migrations. The target's list is read from
  its release tag on GitHub; if that cannot be read the dialog says "Couldn't
  check migrations for this version" and the update is not affected.
- **Rollback point.** Before an update starts, Dokploy writes the image it is
  leaving to `/etc/dokploy/dokploy-update-rollback.json`: the version, the image
  digest, the image the update installs, and the time. No point is recorded when
  the running image cannot be pinned to a digest in the fork's image repository,
  and any old point is removed instead.
- **When "Roll back" is offered.** Only while the `dokploy` service still runs
  the image that update installed. If something else has been installed since,
  the record is stale and the button is not shown. It is also not offered for the
  running version, or for a version older than the oldest release a pinned update
  may install.
- **What it does.** The rollback installs the recorded digest with a forced
  `docker service update`. It is **image-only**: the database is not touched, so
  apply the check in §2 first. A digest is accepted only for the recorded
  rollback; to go to any other version, pin a release tag.

If the dashboard is not reachable, the dialog is not available. Use §4.

## 4. Roll back over SSH

Run on the manager node that hosts Dokploy.

Look first (read-only):

```
docker service ps dokploy --no-trunc --format '{{.Name}} {{.Image}} {{.CurrentState}} {{.Error}}' | head -5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/trpc/settings.health
docker service logs dokploy --since 20m --tail 80
docker service inspect dokploy --format 'now:  {{.Spec.TaskTemplate.ContainerSpec.Image}}{{"\n"}}prev: {{.PreviousSpec.TaskTemplate.ContainerSpec.Image}}'
```

Then pick one.

**A. Swarm still holds the previous spec.** If `prev:` shows the digest you want
(`<previous-digest>`):

```
docker service rollback dokploy
```

**B. Otherwise, or if A fails,** pin the digest:

```
docker service update --force --with-registry-auth \
  --image ghcr.io/devinosolutions/dokploy-community@<previous-digest> \
  dokploy
```

If you only know `<previous-tag>`, read its index digest first
(`docker buildx imagetools inspect ghcr.io/devinosolutions/dokploy-community:<previous-tag>`)
and use the digest, so a later re-tag cannot change what you install.

## 5. Last resort: restore the pre-update backup

Only when the older image also fails to start because of the database, or when
§2 says the migrations are not additive. **This drops the live database.**
Everything written after the backup is lost: deployment rows, settings changes.
It is the owner's decision.

Use the `pg_dump` from the pre-update step, or a web server backup from
Settings → Web Server → Backups. A custom-format dump restores like this:

```
docker service scale dokploy=0
PG=$(docker ps --filter name=dokploy-postgres --filter status=running -q | head -1)
# Safety copy of the current state first.
docker exec $PG pg_dump -Fc -U dokploy -d dokploy -f /tmp/pre-restore.dump
docker cp <backup-file> $PG:/tmp/restore.dump
docker exec $PG psql -U dokploy postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='dokploy' AND pid <> pg_backend_pid();"
docker exec $PG psql -U dokploy postgres -c "DROP DATABASE IF EXISTS dokploy;"
docker exec $PG psql -U dokploy postgres -c "CREATE DATABASE dokploy;"
docker exec $PG pg_restore -U dokploy -d dokploy /tmp/restore.dump
docker service scale dokploy=1   # still on the image you rolled back to
```

A web server backup also contains a copy of `/etc/dokploy` (Traefik dynamic
config, compose files, SSH keys) under `filesystem/`. Restore it only if
`/etc/dokploy` was damaged; it overwrites the live Traefik config.

## 6. Check health afterwards

Allow one to three minutes for startup and migrations.

1. `docker service ps dokploy` shows the task `Running`, on the image digest you
   rolled back to.
2. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/trpc/settings.health`
   returns `200`.
3. Log in. Settings shows the version you expect.
4. The deploy queue page loads. Waiting jobs re-queue by themselves.
5. The logs (`docker service logs dokploy --since 10m`) show no repeating errors.

Then record which step was used, the digest now running, and the health result.
