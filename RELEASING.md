# Releasing

Ludra publishes three npm packages from this monorepo:

| Package | Folder | What it is |
| --- | --- | --- |
| [`@ludra/core`](https://www.npmjs.com/package/@ludra/core) | `packages/core` | Engine runtime |
| [`@ludra/physics`](https://www.npmjs.com/package/@ludra/physics) | `packages/physics` | Rapier physics, loaded only by scenes with `"physics": "rapier"` |
| [`@ludra/cli`](https://www.npmjs.com/package/@ludra/cli) | `packages/cli` | The `ludra` command; depends on `@ludra/core` and `@ludra/physics` |

The CLI can't be called just `ludra` on npm: npm rejects that name as too similar to the existing `lunr` package. Names under our `@ludra` scope are not subject to that check.

All three always share one version number.

## One-time setup

1. **npm account** with two-factor authentication enabled.
2. **The `ludra` npm organization** (free for public packages) at https://www.npmjs.com/org/create, so you can publish under `@ludra/`. All three packages are published under it.
3. **An npm token** that can publish all three packages: an *automation* token, or a *granular* token with read and write access to the whole `@ludra` scope. A granular token limited to specific packages can't publish a package that doesn't exist yet, such as `@ludra/physics` on its first release.
4. **The GitHub secret**: in the repository go to Settings → Secrets and variables → Actions, and add the token as `NPM_TOKEN`.

## Each release

1. Bump the version in `packages/core/package.json`, `packages/cli/package.json` (and its `@ludra/core` dependency), the plugin version in `plugins/ludra/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the template's `packages/cli/templates/platformer/package.json`, then run `npm install` to update the lockfile.
2. Write the release notes in `docs/releases/v<version>.md`. The first line, `# v<version>: <title>`, becomes the release title; the rest is the body. See the earlier files there for the shape: what it's about, highlights with examples, the merged PRs and a changelog link.
3. Merge that to `main` through a pull request so CI checks it.
4. Tag the merge commit and push the tag:

   ```bash
   git tag v0.9.0
   git push origin v0.9.0
   ```

The [Release workflow](.github/workflows/release.yml) then checks that the tag matches every package version, builds, runs the tests, and publishes `@ludra/core`, `@ludra/physics` and then `@ludra/cli` with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), then creates the GitHub release from the notes file. Without a notes file, GitHub generates the notes from the merged pull requests, with links to the npm packages on top. A version that is already on npm, or a release that already exists, is skipped, so if a release fails halfway, fix the cause and re-run the workflow from the Actions tab.

## Checking a release before publishing

CI already packs all three packages, installs the tarballs into an empty project and runs `ludra new`, `check` and `test` there. To do the same by hand:

```bash
npm pack --workspace packages/core --workspace packages/physics --workspace packages/cli --pack-destination ../ludra-pack
```

Then, in an empty folder, run `npm install ../ludra-pack/*.tgz` and `npx ludra new game`.
