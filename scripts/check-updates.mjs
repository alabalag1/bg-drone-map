#!/usr/bin/env node
/**
 * Checks the Bulgarian CAA drone-zone page for a newer dataset and, if one is
 * found, replaces data/bgr_zones_source.json with it. The GitHub Actions
 * workflow then rebuilds the GeoJSON, commits, and opens an issue.
 *
 * This script performs NETWORK access (the CAA page) and only writes the raw
 * source file + manifest — it deliberately does not rebuild, so the workflow
 * controls that step.
 *
 * Local testing (no network):  node scripts/check-updates.mjs --self-test
 *
 * Outputs (when run under GitHub Actions, appended to $GITHUB_OUTPUT):
 *   changed=true|false
 *   version=<title of the applied dataset>
 *   prev_version=<title of the previous dataset>
 *   source_url=<url the dataset was downloaded from>
 *   zones=<feature count>
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const PAGE_URL = "https://www.caa.bg/bg/category/633/7062";
const SOURCE_FILE = join(root, "data", "bgr_zones_source.json");
const MANIFEST_FILE = join(root, "data", "source-manifest.json");
const BODY_FILE = join(root, ".github", "update-body.md");

const UA =
  "Mozilla/5.0 (compatible; bg-drone-map-bot/1.0; +https://github.com/alabalag1/bg-drone-map)";

/* ----------------------------------------------------------------- utils --- */
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Extract absolute URLs of every `.json` link found in an HTML string. */
export function extractJsonLinks(html, baseUrl) {
  const urls = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let resolved;
    try {
      resolved = new URL(m[1], baseUrl);
    } catch {
      continue;
    }
    if (resolved.pathname.toLowerCase().endsWith(".json")) {
      urls.add(resolved.href);
    }
  }
  return [...urls];
}

/**
 * Parse a version date (ms since epoch) from a dataset title and/or filename.
 * Handles "DD-MM-YYYY" (title, e.g. "BGRZoneVersion 30-07-2026") and an
 * 8-digit "DDMMYYYY" run in a filename (e.g. "bgr_zones_30072026.json").
 * Returns NaN when no date can be found.
 */
export function parseVersionDate(title = "", url = "") {
  const fromDashes = /(\d{2})-(\d{2})-(\d{4})/.exec(title || "");
  if (fromDashes) {
    const [, d, mo, y] = fromDashes;
    return Date.UTC(+y, +mo - 1, +d);
  }
  // filename: last path segment, look for 8 consecutive digits DDMMYYYY
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    name = url || "";
  }
  const eight = /(\d{2})(\d{2})(\d{4})/.exec(name.replace(/\D/g, (c) => c));
  const digits = /(\d{8})/.exec(name);
  if (digits) {
    const s = digits[1];
    const d = +s.slice(0, 2),
      mo = +s.slice(2, 4),
      y = +s.slice(4, 8);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y < 2100) {
      return Date.UTC(y, mo - 1, d);
    }
  }
  void eight;
  return NaN;
}

/** Does this parsed object look like the BGR drone-zone dataset? */
export function isZoneDataset(obj) {
  if (!obj || !Array.isArray(obj.features) || obj.features.length === 0) return false;
  const f = obj.features[0];
  const g = Array.isArray(f?.geometry) ? f.geometry[0] : null;
  return Boolean(g && g.horizontalProjection && g.horizontalProjection.type);
}

/**
 * Decide whether `candidates` contains a dataset that should replace the
 * current one. Returns the chosen candidate or null.
 *   - never downgrades (older version date than current)
 *   - applies a same-or-newer date whose content differs (catches corrections)
 */
export function decideUpdate(candidates, currentSha, currentDate) {
  const dated = candidates
    .filter((c) => !Number.isNaN(c.date))
    .sort((a, b) => b.date - a.date);
  const pick = dated[0];
  if (!pick) return null;
  if (pick.sha === currentSha) return null;
  if (!Number.isNaN(currentDate) && pick.date < currentDate) return null;
  return pick;
}

function fetchWithTimeout(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }).finally(
    () => clearTimeout(t),
  );
}

function ghOutput(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  for (const [k, v] of Object.entries(kv)) {
    appendFileSync(out, `${k}=${String(v).replace(/\n/g, " ")}\n`);
  }
}

/* ------------------------------------------------------------------ main --- */
async function main() {
  const currentText = existsSync(SOURCE_FILE) ? readFileSync(SOURCE_FILE) : Buffer.from("");
  const currentSha = currentText.length ? sha256(currentText) : "";
  let currentTitle = "";
  try {
    currentTitle = JSON.parse(currentText.toString() || "{}").title || "";
  } catch {
    /* ignore */
  }
  // Prefer the manifest's recorded version if present (more authoritative).
  if (existsSync(MANIFEST_FILE)) {
    try {
      const man = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
      if (man.title) currentTitle = man.title;
    } catch {
      /* ignore */
    }
  }
  const currentDate = parseVersionDate(currentTitle);

  console.log(`Current dataset: ${currentTitle || "(unknown)"}  sha=${currentSha.slice(0, 12)}`);
  console.log(`Fetching CAA page: ${PAGE_URL}`);

  let html;
  try {
    const res = await fetchWithTimeout(PAGE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`Failed to fetch CAA page: ${err.message}`);
    ghOutput({ changed: false });
    process.exitCode = 0; // don't fail the workflow on a transient network issue
    return;
  }

  const links = extractJsonLinks(html, PAGE_URL);
  console.log(`Found ${links.length} .json link(s):`);
  links.forEach((u) => console.log(`  - ${u}`));

  const candidates = [];
  for (const url of links) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const obj = JSON.parse(text);
      if (!isZoneDataset(obj)) {
        console.log(`  skip (not a zone dataset): ${url}`);
        continue;
      }
      candidates.push({
        url,
        title: obj.title || "",
        text,
        sha: sha256(Buffer.from(text)),
        date: parseVersionDate(obj.title || "", url),
        features: obj.features.length,
      });
      console.log(
        `  candidate: "${obj.title}"  zones=${obj.features.length}  date=${
          Number.isNaN(parseVersionDate(obj.title || "", url))
            ? "?"
            : new Date(parseVersionDate(obj.title || "", url)).toISOString().slice(0, 10)
        }`,
      );
    } catch (err) {
      console.log(`  skip (${err.message}): ${url}`);
    }
  }

  if (!candidates.length) {
    console.log("No valid zone datasets found on the page.");
    ghOutput({ changed: false });
    return;
  }

  const pick = decideUpdate(candidates, currentSha, currentDate);
  if (!pick) {
    console.log("No newer dataset than the current one. Nothing to do.");
    ghOutput({ changed: false, prev_version: currentTitle });
    return;
  }

  console.log(`\n➜ Applying newer dataset: "${pick.title}" from ${pick.url}`);
  writeFileSync(SOURCE_FILE, pick.text);
  const manifest = {
    title: pick.title,
    sourceUrl: pick.url,
    sha256: pick.sha,
    versionDate: Number.isNaN(pick.date)
      ? null
      : new Date(pick.date).toISOString().slice(0, 10),
    features: pick.features,
    fetchedAt: new Date().toISOString(),
    pageUrl: PAGE_URL,
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");

  const body = [
    "## Drone-zone dataset updated",
    "",
    "A newer dataset was published on the CAA page and applied to the map.",
    "",
    `- **Version:** ${pick.title || "(untitled)"}`,
    `- **Source:** ${pick.url}`,
    `- **Zones:** ${pick.features}`,
    `- **Previous version:** ${currentTitle || "(unknown)"}`,
    `- **Detected:** ${manifest.fetchedAt}`,
    "",
    "The GeoJSON was regenerated and committed to `main`; Cloudflare Pages will redeploy automatically.",
    "",
    `_Opened automatically by the [\`update-zones\`](../actions/workflows/update-zones.yml) workflow. Source page: ${PAGE_URL}_`,
  ].join("\n");
  writeFileSync(BODY_FILE, body + "\n");

  ghOutput({
    changed: true,
    version: pick.title || "(untitled)",
    prev_version: currentTitle || "(unknown)",
    source_url: pick.url,
    zones: pick.features,
  });
  console.log("Wrote data/bgr_zones_source.json, data/source-manifest.json, .github/update-body.md");
}

/* ------------------------------------------------------------- self-test --- */
async function selfTest() {
  const assert = (await import("node:assert/strict")).default;

  const html = `
    <ul>
      <li><a href="/files/bgr_zones_30072026.json">Zones 30.07.2026</a></li>
      <li><a href="https://cdn.caa.bg/docs/bgr_zones_15082026.json">Newer</a></li>
      <li><a href="/about.html">Not json</a></li>
      <li><a href="notes.JSON?x=1">Odd casing + query</a></li>
    </ul>`;
  const links = extractJsonLinks(html, PAGE_URL);
  assert.equal(links.length, 3, "should find 3 json links");
  assert.ok(links.includes("https://cdn.caa.bg/docs/bgr_zones_15082026.json"));
  assert.ok(links.some((u) => u.endsWith("/files/bgr_zones_30072026.json")));

  assert.equal(parseVersionDate("BGRZoneVersion 30-07-2026"), Date.UTC(2026, 6, 30));
  assert.equal(
    parseVersionDate("", "https://x/bgr_zones_15082026.json"),
    Date.UTC(2026, 7, 15),
  );
  assert.ok(Number.isNaN(parseVersionDate("no date here", "https://x/file.json")));

  assert.equal(isZoneDataset({ features: [] }), false);
  assert.equal(
    isZoneDataset({
      features: [{ geometry: [{ horizontalProjection: { type: "Circle" } }] }],
    }),
    true,
  );

  const currentSha = "aaa";
  const currentDate = Date.UTC(2026, 6, 30);
  // newer date, different content -> update
  let pick = decideUpdate(
    [{ url: "u1", sha: "bbb", date: Date.UTC(2026, 7, 15) }],
    currentSha,
    currentDate,
  );
  assert.equal(pick?.url, "u1", "newer date should update");
  // older date -> no update
  pick = decideUpdate(
    [{ url: "u2", sha: "ccc", date: Date.UTC(2026, 5, 1) }],
    currentSha,
    currentDate,
  );
  assert.equal(pick, null, "older date should not downgrade");
  // same content -> no update
  pick = decideUpdate(
    [{ url: "u3", sha: "aaa", date: Date.UTC(2026, 7, 15) }],
    currentSha,
    currentDate,
  );
  assert.equal(pick, null, "same sha should not update");
  // same date, different content -> update (correction)
  pick = decideUpdate(
    [{ url: "u4", sha: "ddd", date: Date.UTC(2026, 6, 30) }],
    currentSha,
    currentDate,
  );
  assert.equal(pick?.url, "u4", "same date, changed content should update");
  // picks newest among several
  pick = decideUpdate(
    [
      { url: "old", sha: "e", date: Date.UTC(2026, 6, 30) },
      { url: "new", sha: "f", date: Date.UTC(2026, 8, 1) },
    ],
    currentSha,
    currentDate,
  );
  assert.equal(pick?.url, "new", "should pick the newest candidate");

  console.log("self-test: all assertions passed ✓");
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
