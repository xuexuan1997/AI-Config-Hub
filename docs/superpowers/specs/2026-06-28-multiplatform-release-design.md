# Multiplatform Release Design

## Goal

AI Config Hub releases must include installable desktop artifacts for Windows x64, macOS x64, macOS arm64, and the existing Linux x64 AppImage. The tag-triggered release pipeline must publish only artifacts that were built and verified by the platform packaging jobs.

## Release Matrix

| Platform | Architecture | Runner | Artifact | Output directory |
| --- | --- | --- | --- | --- |
| Linux | x64 | Rocky Linux 8.10 container on Ubuntu | AppImage | `release/linux-x64` |
| Windows | x64 | `windows-latest` | NSIS installer | `release/windows-x64` |
| macOS | x64 | `macos-latest` | DMG | `release/macos-x64` |
| macOS | arm64 | `macos-latest` | DMG | `release/macos-arm64` |

Windows arm64 is explicitly out of scope. Linux keeps the glibc 2.28 baseline and ELF compatibility evidence from the current release process.

## Packaging Configuration

`apps/desktop/electron-builder.yml` remains the shared electron-builder configuration. It keeps the existing app metadata, ASAR packaging, file allowlist, source-map/test/fixture exclusions, and Linux AppImage target. It adds:

- Windows `nsis` target for x64.
- macOS `dmg` target for x64 and arm64.
- Platform-specific artifact names that include version, platform, and architecture.

The build output directory should be controllable per packaging command so each CI job writes into its own release directory. The existing Linux output path remains compatible with current scripts.

## Scripts

Root and desktop package scripts expose platform-specific commands:

- `package:linux:x64`
- `package:windows:x64`
- `package:macos:x64`
- `package:macos:arm64`

The existing `package:linux` may remain as an alias for Linux x64 compatibility. Release evidence scripts accept an output directory and platform metadata instead of assuming `release/linux-x64`.

## Release Evidence

Every platform directory contains:

- installer artifact;
- `sbom.cdx.json`;
- `SHA256SUMS`;
- `version-manifest.json`.

Linux additionally contains `elf-compatibility.json` and `glibcBaseline: "2.28"` in the manifest. Windows and macOS manifests must not require ELF evidence. All manifests include stable package name, version, platform, architecture, generated timestamp, and SHA-256 records for the publishable files in that directory.

Internal electron-builder output such as unpacked app directories and builder debug files must not be listed in `SHA256SUMS` or `version-manifest.json`.

## CI And Release Flow

The packaging workflow builds a matrix of the four target directories. Linux keeps the current Rocky Linux container, dependency installation, full quality gates, AppImage smoke test, ELF audit, evidence generation, and verification. Windows and macOS run the same source build, package their native installer, generate SBOM and manifest evidence, and verify checksums.

The tag-triggered `Release` workflow waits for all packaging jobs, downloads every release candidate artifact, reruns verification for each directory, and uploads every installer plus its evidence files to the GitHub Release. It never rebuilds in the publish job.

## Testing

The first implementation step updates existing packaging and workflow contract tests so they fail against the current Linux-only release setup. Tests must cover:

- electron-builder config contains Linux AppImage, Windows NSIS, and macOS DMG targets;
- workspace scripts expose the four target packaging commands;
- manifest generation accepts platform and architecture metadata;
- Linux manifest includes ELF evidence and glibc baseline;
- Windows and macOS manifests include their installers without ELF requirements;
- release workflow downloads and publishes all four platform directories.

## Out Of Scope

Code signing, macOS notarization, auto-update channels, Windows arm64, and CLI binary packaging are not part of this change. The workflow may keep unsigned installer output until signing credentials are designed separately.
