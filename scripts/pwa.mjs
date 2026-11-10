#!/usr/bin/env node
// Adds PWA + offline support to a built Trunk site (see .github/workflows/pages.yml).
//
//   node scripts/pwa.mjs <dist-dir> [icon.png]
//
// Into <dist-dir> it writes:
//   manifest.webmanifest        installable app: name, icons, display, theme color
//   sw.js                       the service worker: precaches every file in the dist
//   icons/icon-192.png          the manifest's icons, resized from the source PNG
//   icons/icon-512.png
//   icons/icon-maskable-512.png
//   icons/apple-touch-icon.png  (180x180, iOS home screen)
//   icons/favicon-96.png
// and injects <link rel="manifest">, a description meta and the SW registration
// into index.html. The workflow first copies the 1024px icon in as
// icons/vectorcraft-1024.png.
//
// The dist's hashed file names (Trunk's filehash) are content addresses, so precaching
// everything is safe: a weekly rebuild changes only the files whose content changed, and
// the service worker deletes the old cache on activate.
//
// The app itself (wasm-bindgen glue) registers no worker; the inline script this writes
// is the only registration. No npm dependencies: Node's stdlib only.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { spawnSync } from "node:child_process";

const dist = process.argv[2];
if (!dist) {
  console.error("usage: pwa.mjs <dist-dir> [icon.png]");
  process.exit(1);
}

const APP = {
  name: "VectorCraft",
  description: "Vector illustration in the browser. Works offline once loaded.",
  themeColor: "#262626", // matches the loading screen and the status-bar meta tag
};

// ---- icons ---------------------------------------------------------------
//
// The 1024px RGBA master (assets/app-icon/vectorcraft-1024.png in the app repo, copied
// into the dist by the workflow as icons/vectorcraft-1024.png) resized to the sizes the
// manifest and iOS list. Pillow keeps the alpha channel; ImageMagick is the fallback.
// One of the two is on every GitHub runner image.

function resize(input, size, output) {
  const py = spawnSync(
    "python3",
    [
      "-c",
      `from PIL import Image; im = Image.open(${JSON.stringify(input)}); im = im.resize((${size}, ${size}), Image.LANCZOS); im.save(${JSON.stringify(output)})`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (py.status === 0) return;
  const magick = spawnSync("magick", [input, "-resize", `${size}x${size}`, output], { stdio: "inherit" });
  if (magick.status === 0) return;
  console.error(`error: could not resize ${input} with Pillow or ImageMagick`);
  process.exit(1);
}

// The dist ships 32 and 256px icons under icons/ (index.html's data-trunk copy-file
// rules); the workflow drops the 1024px master in beside them as
// icons/vectorcraft-1024.png.
function findIconSource() {
  if (process.argv[3]) return process.argv[3];
  const candidates = [
    join(dist, "icons", "vectorcraft-1024.png"),
    join(dist, "icons", "ai.storyteller.vectorcraft-1024.png"),
    join(dist, "icons", "ai.storyteller.vectorcraft.svg"), // last resort: rasterize below
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  console.error(`error: no icon source found in ${join(dist, "icons")}`);
  process.exit(1);
}

mkdirSync(join(dist, "icons"), { recursive: true });
const iconSource = findIconSource();
const isSvg = iconSource.endsWith(".svg");
const rasterSource = isSvg ? rasterize(iconSource) : iconSource;

function rasterize(svg) {
  // Pillow cannot read SVG; rasterize to a 1024 PNG first (rsvg-convert, then magick).
  const out = join(dist, "icons", ".icon-raster-1024.png");
  const rsvg = spawnSync("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", out, svg], { stdio: "inherit" });
  if (rsvg.status === 0) return out;
  const magick = spawnSync("magick", [svg, "-resize", "1024x1024", out], { stdio: "inherit" });
  if (magick.status === 0) return out;
  console.error(`error: could not rasterize ${svg} (need rsvg-convert or ImageMagick)`);
  process.exit(1);
}

for (const [size, name] of [
  [192, "icon-192.png"],
  [512, "icon-512.png"],
  [512, "icon-maskable-512.png"],
  [180, "apple-touch-icon.png"],
  [96, "favicon-96.png"],
]) {
  resize(rasterSource, size, join(dist, "icons", name));
}

// ---- manifest ------------------------------------------------------------

const manifest = {
  name: APP.name,
  short_name: APP.name,
  description: APP.description,
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "any",
  background_color: APP.themeColor,
  theme_color: APP.themeColor,
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");

// ---- service worker ------------------------------------------------------
//
// Hand-written, not Workbox: the precache list is the whole dist (a few dozen files), and
// a ~60-line worker with no build step is easier to keep correct than an npm dependency
// in CI. Behavior:
//   install:   precache every file; a fonts/ file that fails is skipped (the app logs and
//              runs without that face), anything else fails the install.
//   fetch:     navigations serve index.html (from cache when offline — the installed app
//              starts with no network); other same-origin GETs are cache-first.
//   activate:  delete every cache that isn't this version's, so the weekly file-name
//              churn cleans up after itself.
// Cache-busting: files Trunk content-hashes (wasm, glue, fonts) are cached by URL; the
// rest (index.html, manifest, icons) get a content-hash revision in the precache list,
// with ?v= query strings — the same scheme Workbox uses.

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // .stage, .trunk-lock, scratch files
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const swName = "sw.js";
// Trunk's staging dir (dist/web/.stage) is moved to its final place before this runs, and
// .trunk-lock is gone with it; walk skips dot-dirs to be safe anyway.
const files = walk(dist)
  .map((p) => relative(dist, p).split(sep).join("/")) // URLs always use "/", never "\\"
  .filter((p) => p !== swName) // the worker never precaches itself
  .sort();

// Trunk's filehash puts a 16+ hex digest in the wasm/glue/font file names; they need no
// extra revision. Everything else is revisioned by content hash.
const hashedName = (name) => /-([0-9a-f]{16,})\.(wasm|js|css|png|ttf|otf|woff2?)$/i.test(name);

const precache = files.map((p) => {
  if (hashedName(basename(p))) return { url: p };
  return { url: p, revision: sha256(join(dist, p)).slice(0, 16) };
});

// The deploy date in the cache names: two deploys of identical content still get
// distinct caches (a changed revision in the precache list is what actually invalidates
// entries; the date just keeps the names honest and the activate cleanup total).
const version = new Date().toISOString().slice(0, 10);

const sw = `// Generated by scripts/pwa.mjs — do not edit; rebuilt on every deploy.
const VERSION = "vectorcraft-${version}";
const PRECACHE = "precache-" + VERSION;
const RUNTIME = "runtime-" + VERSION;

// Every file the build ships. Entries with a revision get "?v=<hash>" appended when
// cached (Workbox's scheme): a changed file gets a new revision, so a new URL.
const PRECACHE_URLS = ${JSON.stringify(precache, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map(({ url, revision }) => {
          // Cached under the revisioned URL (a changed file gets a new revision → a new
          // cache entry, so nothing stale survives), but fetched by its plain URL: the
          // page's own concurrent request for the same file can then share the transfer.
          const cacheUrl = revision ? url + "?v=" + revision : url;
          return cache.put(
            new Request(cacheUrl),
            fetch(url).then((r) => {
              if (!r.ok) throw new Error("precache " + url + ": " + r.status);
              return r;
            }),
          ).catch((err) => {
            // A font that fails to precache is skipped: the app logs it and runs without
            // that face (web font … in the console). Anything else fails the install, so
            // a broken deploy is visible in the Actions log rather than only offline at
            // 3am with no way to debug it.
            if (url.startsWith("fonts/")) return;
            throw err;
          });
        }),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== PRECACHE && k !== RUNTIME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations (opening the app, reloads, and the ?webgl / ?cpu renderer flags the app
  // documents) always serve the shell, from the cache when offline. This is what makes
  // the installed app start with no network.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("index.html", { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(req);
      }),
    );
    return;
  }

  // Other same-origin GETs: cache-first (search params ignored, so the browser's plain
  // requests for revisioned precache entries hit), then network (cached into the runtime
  // cache when inside this worker's scope). The app's own font fetches (fonts/<sha>/…)
  // and any fetch() it makes land here and become offline-capable on second run.
  event.respondWith(
    matchPrecache(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && url.pathname.startsWith(scopePath())) {
          const copy = res.clone();
          event.waitUntil(caches.open(RUNTIME).then((cache) => cache.put(req, copy)));
        }
        return res;
      });
    }),
  );
});

// This worker's scope root, "/"-terminated, so runtime caching can be scoped to the app
// (GitHub Pages serves many repos under one origin).
function scopePath() {
  const scope = self.registration.scope;
  return scope.endsWith("/") ? scope : scope + "/";
}

// The precache stores revisioned entries with "?v=<hash>" (Workbox's scheme), but the
// browser requests them without the query (index.html, the manifest, the icons). This
// lookup ignores search params, so those requests still hit the precache offline.
function matchPrecache(req) {
  return caches.match(req, { ignoreSearch: true });
}
`;
writeFileSync(join(dist, swName), sw);

// ---- index.html ----------------------------------------------------------

let html = readFileSync(join(dist, "index.html"), "utf8");

if (!html.includes("manifest.webmanifest")) {
  html = html.replace(
    "</title>",
    `</title>
  <link rel="manifest" href="manifest.webmanifest">
  <meta name="description" content="${manifest.description}">`,
  );
}

if (!html.includes("serviceWorker")) {
  // Register after the page loads: the wasm download starts immediately (its hashed URL
  // is stable, so the precache and the app's own request share one network fetch), and
  // the worker installs behind it.
  html = html.replace(
    "</body>",
    `  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch((err) =>
          console.warn("VectorCraft service worker failed:", err),
        );
      });
    }
  </script>
</body>`,
  );
}
writeFileSync(join(dist, "index.html"), html);

console.log(`pwa.mjs: ${precache.length + 1} files (incl. sw.js) ready in ${dist}`);
console.log(`pwa.mjs: icons from ${iconSource}`);
