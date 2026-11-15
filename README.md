# HighHydra

HighHydra is a macOS fork of [Hydra Launcher](https://github.com/hydralauncher/hydra) based on v4.4.1. It connects Hydra's download and game library flow to [Highball](https://github.com/ZeLebo/highball), so Windows games can be installed and played in their own persistent Wine environments.

## What changed

- Every Windows game gets a stable bottle in Highball's shared storage, keyed by shop and game ID. Game files download and extract inside that bottle; Windows setup and the installed EXE use the same environment.
- The selected game EXE becomes a Highball Pin with a stable UUID, so the game is visible and launchable from both apps. Executables outside the bottle, including symlink escapes, are rejected.
- Play, Running and Stop follow the selected bottle. Closing a detected game normally returns to Play even when Wine reports a nonzero exit status; an unsuccessful launch still reports an error.
- The app, `highhydra://` protocol and profile are separate from Hydra. Upstream Hydra updates cannot overwrite this fork; a HighHydra update channel has not been configured.
- macOS native-addon building and local signing are supported. Windows installer discovery, installation directories and save-path resolution use the game's own bottle.

Steam's shared NotProton bottle is a separate integration and is not used for HighHydra games.

## Requirements and use

Use an updated Highball app with its Wine engine and `Contents/Helpers/highball` installed. Per-game macOS identity also needs the compatible engine and `highball-game-launcher` helper. HighHydra currently uses that external installation; it does not include Highball or an engine in its own package.

Highball can be installed under `~/Applications/Games`, `~/Applications`, `/Applications` or `/Applications/GAMES`. HighHydra follows `HIGHBALL_HOME`, the selected home in Highball's standard `config.json`, or Highball's default storage. The apps share bottles, not Hydra account data.

1. Choose a Windows game download in HighHydra. Its files are placed in its own bottle under `drive_c/Games/Downloads`.
2. After extraction, use Install for a Windows setup. It runs in that same bottle; HighHydra can provision MFC42 there for the supported installer path.
3. Press Play. If the catalogue does not identify the game EXE, select the installed `.exe` inside the bottle. A ready-to-play folder follows the same EXE selection path without a setup step.
4. Stop or close the game, then launch it again. The existing bottle, installed files and saves are reused. The Pin is also available in Highball; an already open Highball may need a new window to refresh its library.

The Windows DirectX Web Installer is not installed automatically over Wine. Additional legacy runtime DLLs, when needed, belong in the affected game's bottle through Highball/winetricks.

## Build from source

The accepted local toolchain was Apple Silicon macOS 27.2, Node.js 26.5, Yarn 1.22.22, Rust 1.97.1 and Apple developer tools. This does not establish support for every other toolchain or CPU.

Configure the existing Hydra API/auth/resource environment for your own setup. Keep credentials out of Git. For the packaged local renderer, leave `MAIN_VITE_LAUNCHER_SUBDOMAIN` empty.

```sh
yarn install --frozen-lockfile
yarn typecheck
node scripts/build-native-addon.cjs
node_modules/.bin/electron-vite build
CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder \
  --mac --arm64 --publish never \
  --config.electronDist=node_modules/electron/dist \
  --config.mac.sign=scripts/sign-mac-adhoc.cjs
```

The native addon replaces the Python RPC used by older Hydra versions. The first native build downloads its pinned build dependencies. On macOS, Rust strip is disabled to avoid the observed misaligned Mach-O LINKEDIT output. The local signer uses ad hoc signing without hardened runtime or notarization; it is not a Developer ID release.

## Checks and accepted games

```sh
TMPDIR=/private/tmp node --import ./scripts/register-ts-node.mjs \
  --test --test-concurrency=4 --test-timeout=60000 \
  'src/**/*.test.ts' 'src/**/*.test.cjs' 'scripts/*.test.mjs'
yarn typecheck
```

The accepted local integration recorded 2,939 tests: 2,918 passed, 21 skipped, none failed. Native-addon, torrent bridge, main/preload/renderer build, package signature, per-bottle lifecycle and installer checks were also run. Geometry Dash portable was checked for launch, game/audio identity and normal close. GTA IV was downloaded, installed in its own bottle and played by the tester through HighHydra.

Long-session stability, Cloud Sync, controllers and compatibility with other games remain unverified. Account sign-in still depends on the configured Hydra services and network; one local setup required a VPN, and that network case was left unchanged. This repository contains source and does not publish a new binary release.

## Upstream and license

HighHydra retains Hydra's [MIT license](LICENSE) and upstream notices. Highball and Wine are separate projects with their own licenses and runtime requirements. Hydra's service infrastructure and download sources are not included in this repository.
