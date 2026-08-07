# Releasing the macOS installer

Publishing a GitHub release automatically runs `.github/workflows/release-desktop.yml`. The
workflow checks out the release tag, runs the tests, builds the ARM64 application, verifies the
bundle and DMG, and attaches these files to the release:

- `Marky-McMarkface-<version>-arm64.dmg`
- `Marky-McMarkface-<version>-arm64.zip`
- `SHA256SUMS.txt`

## One-time GitHub setup

Public distribution outside the Mac App Store requires an active
[Apple Developer Program](https://developer.apple.com/programs/whats-included/) membership. Apple
currently charges US$99 per membership year (or the local equivalent where available). A free
Apple account can build local ad-hoc copies, but it cannot issue the Developer ID certificate used
by Gatekeeper for public downloads.

Before configuring GitHub:

1. Enrol in the Apple Developer Program and enable two-factor authentication for the Apple ID.
2. In **Certificates, Identifiers & Profiles**, create a
   [Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
   Install the downloaded certificate on the Mac that created its signing request.
3. In Keychain Access, export that certificate **together with its private key** as a password-
   protected `.p12` file. Keep this file and its password private.
4. Create an app-specific password at [account.apple.com](https://account.apple.com/) for the
   notarization service, and copy the ten-character Team ID from the Apple Developer membership
   details page.

Create an Actions environment named **release** under **Settings → Environments**. Restrict it to
release tags such as `v*` and, for a public repository, consider requiring a maintainer's approval
before the job can access signing credentials.

For Developer ID signing and Apple notarization, add all five secrets to that environment:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | A base64-encoded `.p12` containing the **Developer ID Application** certificate and private key |
| `MACOS_CERTIFICATE_PASSWORD` | The password used when the `.p12` was exported |
| `APPLE_ID` | The Apple ID belonging to the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific Apple ID password, not the ordinary Apple ID password |
| `APPLE_TEAM_ID` | The ten-character Apple Developer Team ID |

The certificate can be encoded on macOS with:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

If the keychain contains more than one suitable certificate, add the optional environment
variable `APPLE_SIGNING_IDENTITY` with its full identity, for example
`Developer ID Application: Example Person (A1B2C3D4E5)`.

The workflow treats signing as all-or-nothing. With all five secrets it signs and notarizes both
the application and disk image. With no secrets it still creates an ad-hoc development installer,
adds `-UNSIGNED` to the DMG and ZIP names, attaches an `UNSIGNED-BUILD.txt` warning, and writes a
prominent warning to the workflow summary. A partial configuration fails instead of silently
producing a misleading release.

Ad-hoc builds are useful for contributors but are not appropriate as a polished public download:
they have no stable Developer ID, are not checked by Apple's notary service, and may produce
Gatekeeper or repeated Keychain prompts after updates.

## Publishing a release

1. Update `version` in `packages/desktop/package.json`, for example to `0.2.0`.
2. Commit and push the version change, and wait for CI to pass.
3. On GitHub, create a release from that commit with the matching `v`-prefixed tag, for example
   `v0.2.0`.
4. Publish the release. Draft releases do not start the installer workflow.
5. Wait for **Release macOS installer** to complete. The DMG, ZIP, and checksum file will appear
   under the release's assets.

The workflow deliberately refuses a tag that does not match the committed desktop version. It
also refuses to replace an existing release asset, so rerunning a partially uploaded release
cannot silently overwrite a file people may already have downloaded.

This post-publish workflow assumes GitHub's optional immutable-releases setting is disabled.
Immutable releases cannot accept new assets after publication; if that setting is enabled later,
the pipeline must be changed to build and attach assets while the release is still a draft.

The current workflow produces an Apple Silicon (`arm64`) installer. Intel or universal output
should be added as a separate tested release target rather than relabelling this artifact.

## Automatic updates

Developer ID-signed builds look for the exact release asset
`Marky-McMarkface-<version>-arm64.zip`. After the user approves a download, Electron's macOS
updater installs that ZIP and verifies its signing identity. Keep this filename stable: changing
it disables automatic updates for existing installations without making them download an
unrecognised artifact.

Unsigned output intentionally has `-UNSIGNED` in its name, so it can never be selected by the
automatic updater. The app also embeds whether it was produced by the signed release job; copying
or renaming an unsigned ZIP does not enable self-replacement.
