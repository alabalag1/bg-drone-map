#!/usr/bin/env node
/**
 * Converts the raw Bulgarian drone-zone dataset (data/bgr_zones_source.json)
 * into a compact GeoJSON FeatureCollection consumed by the map.
 *
 *  - Polygon zones  -> GeoJSON Polygon geometry
 *  - Circle zones   -> GeoJSON Point geometry + `radius` (metres) property,
 *                      rendered client-side as an accurate metric circle.
 *
 * Only the fields the UI needs are kept, and text values are normalised.
 *
 * Usage:  node scripts/build-data.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const SRC = join(root, "data", "bgr_zones_source.json");
const OUT = join(root, "public", "data", "zones.geojson");
const META = join(root, "public", "data", "meta.json");

const src = JSON.parse(readFileSync(SRC, "utf8"));
const features = src.features ?? [];

const clean = (s) => (typeof s === "string" ? s.trim() : s);

/** Pick the single geometry each feature carries (dataset has exactly one). */
function toGeometry(feature) {
  const g = (feature.geometry ?? [])[0];
  if (!g) return null;
  const proj = g.horizontalProjection ?? {};
  if (proj.type === "Circle") {
    const [lng, lat] = proj.center ?? [];
    return {
      geometry: { type: "Point", coordinates: [lng, lat] },
      radius: proj.radius ?? 0,
      shape: "circle",
    };
  }
  if (proj.type === "Polygon") {
    return {
      geometry: { type: "Polygon", coordinates: proj.coordinates },
      radius: null,
      shape: "polygon",
    };
  }
  return null;
}

let skipped = 0;
const restrictionCounts = {};
const reasonCounts = {};

const out = [];
for (const f of features) {
  const geo = toGeometry(f);
  if (!geo) {
    skipped++;
    continue;
  }
  const g0 = (f.geometry ?? [])[0] ?? {};
  const authority = (f.zoneAuthority ?? [])[0] ?? {};
  const applicability = (f.applicability ?? [])[0] ?? {};
  const reasons = (f.reason ?? []).map(clean).filter(Boolean);
  const restriction = clean(f.restriction) || "UNKNOWN";

  restrictionCounts[restriction] = (restrictionCounts[restriction] || 0) + 1;
  for (const r of reasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;

  out.push({
    type: "Feature",
    geometry: geo.geometry,
    properties: {
      id: clean(f.identifier),
      name: clean(f.name),
      restriction,
      reasons,
      otherReasonInfo: clean(f.otherReasonInfo) || "",
      message: clean(f.message) || "",
      // Vertical extent (metres AGL/AMSL).
      lower: g0.lowerLimit ?? null,
      lowerRef: clean(g0.lowerVerticalReference) || "",
      upper: g0.upperLimit ?? null,
      upperRef: clean(g0.upperVerticalReference) || "",
      // Applicability (permanent or a time window).
      permanent: clean(applicability.permanent) || "",
      startDateTime: clean(applicability.startDateTime) || "",
      endDateTime: clean(applicability.endDateTime) || "",
      // Authority / contact.
      authorityName: clean(authority.name) || "",
      authorityPurpose: clean(authority.purpose) || "",
      contactName: clean(authority.contactName) || "",
      email: clean(authority.email) || "",
      phone: clean(authority.phone) || "",
      intervalBefore: clean(authority.intervalBefore) || "",
      // Rendering helpers.
      shape: geo.shape,
      radius: geo.radius,
    },
  });
}

const collection = { type: "FeatureCollection", features: out };
writeFileSync(OUT, JSON.stringify(collection));

const meta = {
  title: src.title ?? "",
  generatedAt: new Date().toISOString(),
  total: out.length,
  skipped,
  restrictions: restrictionCounts,
  reasons: reasonCounts,
};
writeFileSync(META, JSON.stringify(meta, null, 2));

console.log(`Wrote ${out.length} features to public/data/zones.geojson`);
if (skipped) console.log(`Skipped ${skipped} features without usable geometry`);
console.log("Restrictions:", restrictionCounts);
console.log("Reasons:", reasonCounts);
