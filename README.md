# vectorcraft-web

The WASM build of [VectorCraft](https://github.com/storytold/vectorcraft), published to
GitHub Pages every week — as an installable PWA that works offline.

**URL:** `https://<owner>.github.io/vectorcraft/` (this repo's Pages site)

## How it works

A single workflow, [`.github/workflows/pages.yml`](.github/workflows/pages.yml):

1. **Weekly** (Mondays 03:07 UTC; also on pushes that change the workflow or the PWA
   script, and manually via *Run workflow*) it checks out `storytold/vectorcraft@main`.
2. Builds the Trunk site (`apps/vectorcraft-web`) for `wasm32-unknown-unknown` with
   WebAssembly SIMD enabled, the same way the upstream release pipeline does.
3. Adds PWA support with [`scripts/pwa.mjs`](scripts/pwa.mjs): a web app manifest,
   resized icons, and a service worker that **pre-caches every file in the dist** —
   the wasm (~90 MB uncompressed, ~30 MB over the wire), the JS glue, the fonts —
   so the app starts with no network at all once first loaded.
4. Deploys the dist to GitHub Pages.

The app's file names are content-hashed (Trunk's `filehash`), so the weekly rebuild only
changes the URLs of files whose content changed; the service worker downloads those and
deletes the old cache on activate. An update costs the difference, not the whole site —
except when the wasm itself changes, which is most weeks.

## Offline behavior

- First visit: everything is downloaded and precached — roughly 30 MB compressed
  (the wasm is most of it). The service worker installs while the app already runs.
- Later visits, offline: the app starts from the cache. Documents are stored in
  `localStorage` by the app itself; fonts, the manifest and icons come from the precache.
- The renderer flags the app documents (`?webgl`, `?cpu`) work offline too — navigations
  serve the shell regardless of query string.

## Fonts

The build checks out [`storytold/craft-fonts`](https://github.com/storytold/craft-fonts)
at the rev upstream's release pipeline pins (`craft-fonts-ref` in their `release.yml`).
The three *startup* faces — Noto Sans Arabic, Thai and Georgian — are served and
pre-cached; the app fetches them beside the wasm. The *background* display families the
app's `web-fonts.txt` also lists (Tajawal, Amiri, …) are not in that manifest and are
skipped with a warning in the build log — they're optional menu fonts, and the app runs
without them. A font that fails to pre-cache is skipped the same way: the app logs it and
falls back.

## Setup (once, after the first push)

1. **Settings → Pages**: source **GitHub Actions**.
2. **Actions**: enable workflows if asked; run *Publish WASM to Pages* once manually to
   verify the deploy, rather than waiting for Monday.

No secrets: Pages deploys use the repo's own OIDC token (`id-token: write`).

## Local test

```sh
# the app repo, beside this one
cd ../vectorcraft/apps/vectorcraft-web
trunk build --release

# this repo: add PWA support to the dist and serve it
cd ../../vectorcraft-web
cp ../vectorcraft/assets/app-icon/vectorcraft-1024.png ../vectorcraft/dist/web/icons/
node scripts/pwa.mjs ../vectorcraft/dist/web
python3 -m http.server 8765 --directory ../vectorcraft/dist/web
# open http://localhost:8765/, then DevTools › Application:
#   Manifest (installability), Service Workers (sw.js activated), and
#   Offline (reload with network off — the app still starts)
```

The build needs `trunk` and the `wasm32-unknown-unknown` rustup target. Nothing else: the
icon resize is this repo's own code (`scripts/png.mjs`, Node stdlib only — the GitHub
runner image ships neither Pillow nor ImageMagick, so it can't depend on them).

## Why a separate repo

Upstream's own release pipeline publishes a zip to GitHub Releases, not a live site. This
repo is the live site: it tracks upstream `main` weekly, needs no secrets, and can be
pointed at a fork or a pinned rev by editing one line (`ref:` in the workflow).
