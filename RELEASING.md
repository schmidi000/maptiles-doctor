# Releasing

Every package in the workspace ships on the same version number. The tag is what
triggers a release; nothing publishes on a push to `main`.

## What gets published where

| Artifact                  | Registry            | How consumers reference it                            |
| ------------------------- | ------------------- | ----------------------------------------------------- |
| `maptiles-doctor`         | npm                 | `npx maptiles-doctor`                                 |
| `@maptiles-doctor/core`   | npm                 | `npm i @maptiles-doctor/core`                         |
| `@maptiles-doctor/report` | npm                 | `npm i @maptiles-doctor/report`                       |
| `@maptiles-doctor/action` | npm                 | Mostly for completeness; CI uses the repository path. |
| GitHub Action             | This repository     | `schmidi000/maptiles-doctor/packages/action@v0.1.0`   |
| `maptiles-doctor-vscode`  | VS Code Marketplace | Published manually from the `.vsix`.                  |

## Cutting a release

1. Make sure `main` is green and `npm run check` passes locally.
2. Bump the version in every `packages/*/package.json` to the same value.
3. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and
   date, and add the compare links at the bottom.
4. Commit: `chore(release): vX.Y.Z`.
5. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin main --follow-tags
   ```

The `Release` workflow then runs `npm run check`, verifies the tag matches the
package versions, publishes the npm packages in dependency order with
provenance, moves the major-version tag for Action consumers, and opens the
GitHub release.

To rehearse without publishing, run the workflow manually with `dry-run` left at
its default: it runs the whole gate and packs the tarballs instead.

## Prerequisites, once

- A `release` environment on the repository (Settings → Environments). Add
  yourself as a required reviewer: the job then pauses before publishing until
  someone approves it. A publish cannot be taken back — npm will not let a
  version number be reused — so a mistyped tag should stop at a prompt rather
  than at the registry.
- An npm automation token in the **environment** secret `NPM_TOKEN`, scoped to
  the `maptiles-doctor` package and the `@maptiles-doctor` scope. Put it on the
  environment rather than the repository, so only a job that asks for `release`
  can read it. Nothing else in this repository needs npm credentials.
- The `@maptiles-doctor` scope must exist on npm, and the first publish of each
  scoped package needs `--access public` — which the workflow passes, and
  `publishConfig.access` also sets.

## Follow-up: drop the token for trusted publishing

npm authenticates a publish over OIDC as well, using the same `id-token` the
provenance attestation already needs — which this workflow already requests. Once
a package exists on the registry, a trusted publisher can be registered against
it and `NPM_TOKEN` deleted, leaving no long-lived credential in the repository at
all.

It cannot be set up before the first publish, because the configuration lives on
the package on npmjs and the package does not exist yet. So, after `0.1.0` ships:

1. For each of `maptiles-doctor`, `@maptiles-doctor/core`,
   `@maptiles-doctor/report` and `@maptiles-doctor/action`, open the package
   settings on npmjs and add a trusted publisher: this repository, workflow
   `release.yml`, environment `release`.
2. Drop `NODE_AUTH_TOKEN` from the publish step in
   `.github/workflows/release.yml`.
3. Delete the `NPM_TOKEN` secret.

Keep `--provenance`: it is what ties a published tarball to the workflow run that
built it, and it is independent of how the publish authenticated.

## Versioning

Semantic versioning. Pre-1.0, a breaking change may arrive in a minor release.

Report schema v1 is exempt: it is a consumer contract, and its shape will not
break within `schemaVersion: "1.0"`. A breaking change to the report format
means a new `schemaVersion`.

## The Action's major tag

The release workflow force-moves `v0` (or `v1`, and so on) onto each release
commit, which is the convention Action consumers expect. Pre-1.0 that tag
follows the latest `0.x`, which may contain breaking changes — pin the exact
`vX.Y.Z` tag if that matters to you.

## The VS Code extension

Not part of the automated release. Build and publish it separately:

```bash
npm run package:vsix
npx vsce publish --packagePath maptiles-doctor-vscode.vsix
```

## Documentation

`site/index.html` deploys to GitHub Pages at <https://maptiles-doctor.com/> from
the `Documentation` workflow. It runs on a push to `main` that touches `site/`,
and can also be dispatched manually. Behaviour described on that page is the
contract; where the site and the code disagree, the code is the bug — so update
the site in the same PR that changes behaviour, not at release time.

`site/CNAME` binds the deploy to the custom domain and must stay in the uploaded
directory: GitHub reads the Pages domain from the deployed artifact, so a deploy
without it reverts the site to the `github.io` address.

DNS for the apex domain points at GitHub's Pages servers:

| Type    | Name  | Value                                                                                      |
| ------- | ----- | ------------------------------------------------------------------------------------------ |
| `A`     | `@`   | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`                 |
| `AAAA`  | `@`   | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
| `CNAME` | `www` | `schmidi000.github.io.`                                                                    |

Then set the custom domain under **Settings → Pages** and enable **Enforce
HTTPS** once the certificate has been issued.
