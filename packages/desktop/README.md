# Desktop distribution

The desktop package is an alternative installation of the same local application. Electron owns
the native window and lifecycle; the existing Hono server is bundled into its main process and
continues to bind only to `127.0.0.1`. The React UI remains a sandboxed renderer with no Node.js
access.

The app does not request Keychain access on launch. Before saving or unlocking a GitHub
connection it explains why macOS may show “Marky McMarkface Safe Storage”, what the system dialog
can access, and that the password is handled by macOS. A session-only connection is available for
users who do not want to grant persistent access.

Packaged builds check `bastiankoerber/marky-mcmarkface` on GitHub for a newer stable release
shortly after launch and every six hours while running. The comparison happens locally; the
request contains no GitHub token, repository data, or analytics identifier. The app asks before
downloading anything and asks again before restarting to install it. **Marky McMarkface → Check
for Updates…** performs the same check manually.

Automatic replacement is enabled only in Developer ID-signed release builds installed outside a
read-only DMG. Ad-hoc development builds offer the GitHub release page instead. The updater accepts
only the exact signed ZIP filename produced by this repository's release workflow, and Electron's
Squirrel.Mac updater verifies the application signature before replacing the installed app.

```bash
pnpm desktop:run      # build and launch without creating an installer
pnpm desktop:package  # create Marky McMarkface.app
pnpm desktop:make     # create the app, ZIP, and macOS DMG
```

Generated artifacts are written beneath `packages/desktop/out/` and are intentionally ignored by
Git. The application bundle includes the MIT license and third-party notices.

## Release signing

Local Apple Silicon output is ad-hoc signed. The release workflow switches Electron Forge to a
Developer ID identity and Apple notarization when its protected GitHub environment contains the
required secrets. It then notarizes and staples the DMG separately before uploading it.

See [the release guide](../../docs/releasing.md) for the one-time secret setup and publishing
steps. Never commit signing certificates, private keys, or notarization credentials.
