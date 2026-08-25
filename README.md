# 🚁 Bulgaria Drone No-Fly Zones · Дрон зони България

An interactive map of the **881 no-fly / restricted drone zones** in Bulgaria,
built as a fast static site with [Leaflet](https://leafletjs.com/) and ready to
deploy to **Cloudflare Pages**.

<p align="center">
  <em>Bilingual (BG / EN) · filter by restriction & reason · search · click for details · locate me</em>
</p>

## Features

- **All 881 zones** rendered on an OpenStreetMap base map — 460 polygons and 421
  metric circles, coloured by restriction level.
- **Filter** by restriction (Prohibited / Authorisation required / Conditional)
  and by reason (Sensitive site, Privacy, Air traffic, Foreign territory, Nature).
- **Search** any zone by name or identifier and fly to it.
- **Click a zone** for a detail popup: altitude limits, reasons, applicability
  (permanent or seasonal window), authority, contact e-mail/phone and the
  official message.
- **Locate me** centres the map on your GPS position to check nearby zones.
- **Bilingual UI** — Bulgarian / English toggle (zone messages stay in the
  original Bulgarian as issued by the authority).
- **No API keys, no CDN, no build framework** — Leaflet is vendored locally and
  the whole site is static files.

## Project layout

```
.
├── public/                 # ← deployed as-is (Cloudflare Pages output dir)
│   ├── index.html
│   ├── app.js              # map logic: layers, filters, search, popups, i18n
│   ├── i18n.js             # BG/EN strings + enum labels
│   ├── styles.css
│   ├── favicon.svg
│   ├── _headers            # Cloudflare Pages cache/security headers
│   ├── data/
│   │   ├── zones.geojson   # generated dataset consumed by the map
│   │   └── meta.json       # dataset metadata (version, counts)
│   └── vendor/leaflet/     # vendored Leaflet (no CDN dependency)
├── data/
│   └── bgr_zones_source.json   # original source dataset
├── scripts/
│   ├── build-data.mjs      # source JSON  → public/data/zones.geojson
│   ├── sync-vendor.mjs     # node_modules/leaflet → public/vendor/leaflet
│   └── serve.mjs           # zero-dependency local static server
├── wrangler.toml           # Cloudflare Pages config
└── package.json
```

## Develop locally

```bash
npm install        # installs Leaflet (wrangler is fetched via npx on deploy)
npm run build      # regenerate GeoJSON and vendored Leaflet into public/
npm run dev        # serve public/ at http://localhost:8788
```

`npm run dev` uses a tiny built-in Node server (no dependencies). Any static
server pointed at `public/` works just as well.

## Regenerating the dataset

When a new official zone dataset is released, replace
`data/bgr_zones_source.json` with the new file and run:

```bash
npm run build:data
```

This rewrites `public/data/zones.geojson` and `public/data/meta.json`. The
build converts circle geometries to GeoJSON points carrying a `radius` (metres)
property, which the map renders as accurate metric circles.

## Deploy to Cloudflare Pages

The site is a static bundle in `public/`, deployed as a Cloudflare **Pages**
project (configured in `wrangler.toml` via `pages_build_output_dir`).

### Option A — Wrangler CLI

```bash
npm run build
npx wrangler pages deploy public
```

(`npm run deploy` runs both steps.)

### Option B — Git integration (recommended for CI)

In the Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to
Git**, select this repository and use:

| Setting                | Value           |
| ---------------------- | --------------- |
| Build command          | `npm run build` |
| Build output directory | `public`        |

`wrangler.toml` sets `pages_build_output_dir = "public"`, so Cloudflare picks up
the output directory automatically. Pages then builds and deploys on every push —
no separate deploy command is needed.

## Automatic data updates

A weekly GitHub Actions workflow (`.github/workflows/update-zones.yml`) checks the
official CAA page for a newer zone dataset:

- **When:** Mondays 04:00 UTC (plus a manual **Run workflow** button in the
  Actions tab).
- **What it does:** `scripts/check-updates.mjs` fetches
  <https://www.caa.bg/bg/category/633/7062>, finds `.json` links, downloads and
  validates each as a zone dataset, and compares the newest to the current one
  (tracked in `data/source-manifest.json`). It never downgrades to an older
  version.
- **On a newer dataset:** it replaces `data/bgr_zones_source.json`, rebuilds the
  GeoJSON, commits to `main` (Cloudflare redeploys automatically), **and** opens
  a tracking issue labelled `data-update`.

To change the cadence, edit the `cron` in the workflow. To test the detection
logic without network access:

```bash
node scripts/check-updates.mjs --self-test
```

## Data & disclaimer

Source: Bulgarian drone-zone dataset **"BGRZoneVersion 30-07-2026"** (881
features). Zone messages and authority details are reproduced as issued.

> ⚠️ This map is for **informational purposes only** and may be out of date.
> Always verify the current official sources (Bulgarian CAA / ГД ГВА) before any
> flight.

## License

MIT (application code). The zone dataset belongs to its original authority.
