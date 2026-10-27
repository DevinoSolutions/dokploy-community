# Dokploy Community off-canary hotfix runbook

Use this when production needs a fix while `canary` already holds unreleased
work, so the fix cannot ship by releasing canary. The fix is released from the
previous release tag as `v0.30.8-community.NN.1`, where `NN` is the release being
patched. When disclosure is not yet allowed, describe such a fix only as "a fix
shipped from the release tag".

Related: [update rollback runbook](update-rollback-runbook.md),
[build-once rollout runbook](build-once-rollout-runbook.md).

1. **Fix commit.** Build the fix as one commit on `canary`. Open its PR into
   canary only when disclosure allows. Cherry-pick it with `-x` onto
   `release/v0.30.8-community.NN.1`, cut from the release tag, and check the code
   diff is identical (compare an md5 of `git diff`, excluding `CHANGELOG.md`).
2. **Release commit.** Bump `apps/dokploy/package.json` to
   `v0.30.8-community.NN.1` and add a `### New in v0.30.8-community.NN.1` section
   to `CHANGELOG.md`, under the empty `### Unreleased`. The CHANGELOG must have no
   CR characters and exactly one Unreleased heading, and the older part must be
   byte-identical to the previous tag.
3. **Gate.** Run the full vitest run on the release branch, and the same failing
   files (if any) on the bare previous tag to show the result is identical. Run
   `tsc` for `packages/server`. Get a review of the fix.
4. **Push.** Push only the release branch and an annotated tag
   `v0.30.8-community.NN.1`. No workflow fires on `release/*` or on tags.
5. **Publish the GitHub Release with the tag.**
   `gh release create v0.30.8-community.NN.1 --repo DevinoSolutions/dokploy-community --verify-tag --latest --title v0.30.8-community.NN.1 --notes-file <notes>`.
   The in-app update check (`settings.getUpdateData`) compares GitHub
   `releases/latest` by semver and never looks at the image. Without the Release
   the dialog says "You are using the latest version". Verify that
   `settings.getUpdateData` returns `updateAvailable: true`.
6. **Image.** Run `gh workflow run "Dokploy Docker Build" --ref release/v0.30.8-community.NN.1`.
   It publishes only `:v0.30.8-community.NN.1`, because canary's tip differs, so
   `:canary` and `:latest` are untouched. Note the **index** digest
   (`docker buildx imagetools inspect`); that is the rollback and pin target.
7. **Smoke test.** On a scratch host with no Docker socket mounted, start a
   throwaway Postgres and Redis. Start the previous release first, then
   `NN.1` on the same database. Check health returns 200, the migration count is
   unchanged, and `/app/package.json` reports the `NN.1` version. Clean
   everything up.
8. **`:latest` (optional).** It only matters for fresh installs and manual
   pulls, because Update Server installs `:<latestVersion>`. If you re-tag it,
   hold canary merges until the instance is updated, or the next canary push
   moves `:latest` back.
9. **Update.** Whoever operates the instance runs Update Server once the deploy
   queue has no active jobs (never while jobs are active), with a fresh backup,
   and records the proof (`settings.getDokployVersion` and a screenshot).
   Rollback is the previous release's index digest, image-only; see the
   [update rollback runbook](update-rollback-runbook.md).
10. **After.** Lift any freeze and merge the fix's canary PR (CI-gated). Never
    merge the version bump into canary: the next release cut adds the `NN.1`
    section to canary's CHANGELOG.
