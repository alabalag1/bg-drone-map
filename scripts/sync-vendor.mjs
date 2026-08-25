#!/usr/bin/env node
/**
 * Copies Leaflet's distributed files from node_modules into public/vendor
 * so the site has no runtime CDN dependency. Run as part of `npm run build`.
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "node_modules", "leaflet", "dist");
const dest = join(root, "public", "vendor", "leaflet");

if (!existsSync(dist)) {
  console.error("leaflet not found in node_modules — run `npm install` first.");
  process.exit(1);
}

mkdirSync(join(dest, "images"), { recursive: true });
copyFileSync(join(dist, "leaflet.js"), join(dest, "leaflet.js"));
copyFileSync(join(dist, "leaflet.css"), join(dest, "leaflet.css"));
for (const img of readdirSync(join(dist, "images"))) {
  copyFileSync(join(dist, "images", img), join(dest, "images", img));
}
console.log("Synced Leaflet into public/vendor/leaflet");
