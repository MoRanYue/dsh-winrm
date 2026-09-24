# Releasing

The package publishes to npm as `dsh-winrm`. Releases are cut by pushing a
version tag; the [release workflow](.github/workflows/release.yml) then
publishes that exact commit.

## One-time bootstrap: the first version

**npm cannot publish a package's first version over OIDC.** Trusted publishing
is configured on the package's page on npmjs.com, and a package that does not
exist yet has no such page — a chicken-and-egg limit tracked in
[npm/cli#8544](https://github.com/npm/cli/issues/8544). The first release
therefore has to be published manually, with a token or `npm login`:

```sh
npm login          # or export a granular publish token
npm publish
```

Verify the result, then finish the setup:

```sh
npm view dsh-winrm version
```

## One-time bootstrap: authorize this workflow

After the first version exists, open the package on npmjs.com →
**Settings → Trusted publishing → GitHub Actions** and register:

| Field | Value |
| --- | --- |
| Organization or user | `MoRanYue` |
| Repository | `dsh-winrm` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |

The workflow filename must match exactly, including the `.yml` extension;
npm does not validate the entry when it is saved, so a typo only shows up as an
`ENEEDAUTH` failure on the next release.

Once trusted publishing works, consider restricting token-based publishing
(Settings → Publishing access) and revoking unused automation tokens.

## Cutting a release

1. Update `version` in `package.json` and add a matching `CHANGELOG.md` entry.
2. Run the checks locally:

   ```sh
   pnpm install
   npm run check     # typecheck + build + tests
   ```

3. Commit, then tag and push:

   ```sh
   git tag v0.1.1
   git push origin main v0.1.1
   ```

The workflow rejects a tag whose version does not match `package.json`, and
`npm publish` runs the `prepack` script, so a revision that fails the checks is
never published. Provenance attestations are generated automatically: this is
a public package built from a public repository.

## Manual publish

The workflow is a convenience, not a requirement — a maintainer can always
publish by hand from a clean checkout (`npm run check && npm publish`). OIDC is
preferred because it needs no long-lived token in the repository.
