# Releasing

Ludra publishes two npm packages from this monorepo:

| Package | Folder | What it is |
| --- | --- | --- |
| [`@ludra/core`](https://www.npmjs.com/package/@ludra/core) | `packages/core` | Engine runtime |
| [`ludra`](https://www.npmjs.com/package/ludra) | `packages/cli` | The `ludra` command; depends on `@ludra/core` |

Both always share one version number.

## One-time setup

1. **npm account** with two-factor authentication enabled.
2. **The `ludra` npm organization** (free for public packages) at https://www.npmjs.com/org/create, so you can publish under `@ludra/`. If the name is taken, rename `@ludra/core` to `ludra-core` in `packages/core/package.json`, the dependency in `packages/cli/package.json` and the imports in `packages/cli/src`.
3. **An npm token** that can publish both packages: an *automation* token, or a *granular* token with read and write access to `ludra` and the `@ludra` scope.
4. **The GitHub secret**: in the repository go to Settings → Secrets and variables → Actions, and add the token as `NPM_TOKEN`.

## Each release

1. Bump the version in `packages/core/package.json`, `packages/cli/package.json` (and its `@ludra/core` dependency), the plugin version in `plugins/ludra/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the template's `packages/cli/templates/platformer/package.json`, then run `npm install` to update the lockfile.
2. Merge that to `main` through a pull request so CI checks it.
3. Tag the merge commit and push the tag:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

The [Release workflow](.github/workflows/release.yml) then checks that the tag matches both package versions, builds, runs the tests, and publishes `@ludra/core` and then `ludra` with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## Checking a release before publishing

CI already packs both packages, installs the tarballs into an empty project and runs `ludra new`, `check` and `test` there. To do the same by hand:

```bash
npm pack --workspace packages/core --workspace packages/cli --pack-destination ../ludra-pack
```

Then, in an empty folder, run `npm install ../ludra-pack/*.tgz` and `npx ludra new game`.
