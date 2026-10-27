# Layercraft Stack

Layered laser-cut art in the browser. Describe what you want (the Hero, plus an optional Pop), the AI draws it flat and cut-ready, Layercraft traces it into physical sheets, and you export one SVG with every layer named.

- Runs entirely in the browser: tracing, layer building and the depth model are local.
- Paid AI is pay-per-use, Bitcoin only, straight to a [Routstr](https://routstr.com) node you choose. No accounts. Credit stays in your browser until you refund it (Lightning address or Cashu).
- Bundled FOSS fonts, no third-party font or script requests.

Live: `https://chiefmonkey.art/layercraft/` (launcher tile on the Torii Base homepage).

## Develop

```sh
npm ci
npx vite            # dev server
npx tsc --noEmit -p . && npx vite build
npm run test:compose && npm run test:trace
bash tools/test-ops.sh
```

The build uses a relative base, so `dist/` works from any subpath.

## Release and deploy

1. Bump `VERSION` (shown in the app header) and commit to `main`.
2. Tag and push: `git tag v$(cat VERSION) && git push origin v$(cat VERSION)`.
3. Deploy from the tag (a tag never deploys itself):

```sh
gh workflow run deploy.yml --repo ChiefmonkeyArt/layercraft --ref v$(cat VERSION)
```

The workflow builds, tests, packs `dist/` with `tools/pack.sh`, checks the VPS host key against `VPS_DEPLOY_HOST_KEY`, sends the tarball through the restricted key and polls `/layercraft/VERSION` until it matches.

## VPS layout (Torii Base host)

- Releases: `/apps/layercraft/releases/<utc-stamp>`, `current` symlink, newest 5 kept.
- nginx: `/opt/torii/nginx-fragments/layercraft.conf`, written by the installer; `nginx -t` failure rolls back fragment and release.
- Launcher: `torii register layercraft …` at the release `VERSION`, then `torii reload`.

The deploy key is restricted: sshd forces it to run only `/usr/local/bin/layercraft-deploy` (no shell, pty or forwarding). That dispatcher caps the upload, checks it against an allowlist (only the app's folders and file types, regular files, no links or hidden names) and hands it to the pinned root installer `/usr/local/sbin/layercraft-install-root` through one sudoers rule. `ops/bootstrap-vps.sh` installs both byte-for-byte from `ops/` and is re-run only when `ops/` changes.

One-time owner setup on the VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/ChiefmonkeyArt/layercraft/<commit>/ops/bootstrap-vps.sh | sudo bash -s -- <deploy-key-blob> <commit>
```

## Privacy and credit

The Routstr session key is kept in this origin's `localStorage`. Apps served from the same domain share that storage, so keep balances small and refund when done. Optional Nostr sync encrypts the session to your own key through a NIP-07 signer; Layercraft never sees an nsec.

## Licence

Layercraft is free software under the GNU General Public License v3.0 or later (`GPL-3.0-or-later`, see `LICENSE`).

Bundled third-party parts: Depth Anything V2 Small (ONNX, Apache-2.0) is bundled under `public/models/`. Fonts are OFL.
