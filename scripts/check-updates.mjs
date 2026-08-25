#!/usr/bin/env node
/**
 * Checks the Bulgarian CAA drone-zone page for a newer dataset and, if one is
 * found, replaces data/bgr_zones_source.json with it. The GitHub Actions
 * workflow then rebuilds the GeoJSON, commits, and opens an issue.
 *
 * The dataset on the CAA page is published as an attachment that may be a raw
 * `.json` file OR a `.zip` archive containing the `.json`. Both are handled.
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
import { inflateRawSync } from "node:zlib";
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

/** Extract absolute URLs of every `.json` or `.zip` link found in HTML. */
export function extractDataLinks(html, baseUrl) {
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
    const path = resolved.pathname.toLowerCase();
    if (path.endsWith(".json") || path.endsWith(".zip")) urls.add(resolved.href);
  }
  return [...urls];
}

/**
 * Minimal ZIP reader (no dependencies): returns the `.json` entries as
 * { name, text }. Uses the central directory for sizes/offsets and Node's
 * built-in zlib for DEFLATE (method 8) or stored (method 0) entries.
 */
export function unzipJsonEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const LOC_SIG = 0x04034b50;

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end-of-central-directory record)");

  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const out = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith(".json")) continue;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG)
      throw new Error(`bad local header for ${e.name}`);
    const lNameLen = buf.readUInt16LE(e.localOffset + 26);
    const lExtraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + e.compSize);
    let content;
    if (e.method === 0) content = Buffer.from(data);
    else if (e.method === 8) content = inflateRawSync(data);
    else throw new Error(`unsupported ZIP compression method ${e.method} for ${e.name}`);
    out.push({ name: e.name, text: content.toString("utf8") });
  }
  return out;
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
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    name = url || "";
  }
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

function fetchWithTimeout(url, ms = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }).finally(
    () => clearTimeout(t),
  );
}

/**
 * Download a link and return the JSON payload(s) it yields: the file itself
 * for `.json`, or every `.json` entry inside a `.zip`.
 * Each result is { text, from } where `from` describes the origin.
 */
async function loadJsonPayloads(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".zip")) {
    const buf = Buffer.from(await res.arrayBuffer());
    const entries = unzipJsonEntries(buf);
    if (!entries.length) throw new Error("zip contains no .json entry");
    return entries.map((e) => ({ text: e.text, from: `${url} → ${e.name}` }));
  }
  return [{ text: await res.text(), from: url }];
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
    return; // don't fail the workflow on a transient network issue
  }

  const links = extractDataLinks(html, PAGE_URL);
  console.log(`Found ${links.length} .json/.zip link(s):`);
  links.forEach((u) => console.log(`  - ${u}`));

  const candidates = [];
  for (const url of links) {
    let payloads;
    try {
      payloads = await loadJsonPayloads(url);
    } catch (err) {
      console.log(`  skip (${err.message}): ${url}`);
      continue;
    }
    for (const { text, from } of payloads) {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        console.log(`  skip (not JSON): ${from}`);
        continue;
      }
      if (!isZoneDataset(obj)) {
        console.log(`  skip (not a zone dataset): ${from}`);
        continue;
      }
      const date = parseVersionDate(obj.title || "", from);
      candidates.push({
        url: from,
        title: obj.title || "",
        text,
        sha: sha256(Buffer.from(text)),
        date,
        features: obj.features.length,
      });
      console.log(
        `  candidate: "${obj.title}"  zones=${obj.features.length}  date=${
          Number.isNaN(date) ? "?" : new Date(date).toISOString().slice(0, 10)
        }  <- ${from}`,
      );
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
    <table>
      <tr><td><a href="/bg/download/attachment/12345/zones_30072026.zip">json файл – 30.07.2026</a></td></tr>
      <tr><td><a href="https://cdn.caa.bg/docs/bgr_zones_15082026.json">Raw json</a></td></tr>
      <tr><td><a href="/about.html">Not data</a></td></tr>
      <tr><td><a href="notes.ZIP?v=2">Odd casing + query</a></td></tr>
    </table>`;
  const links = extractDataLinks(html, PAGE_URL);
  assert.equal(links.length, 3, "should find 2 zip + 1 json");
  assert.ok(links.some((u) => u.endsWith("/zones_30072026.zip")));
  assert.ok(links.includes("https://cdn.caa.bg/docs/bgr_zones_15082026.json"));

  assert.equal(parseVersionDate("BGRZoneVersion 30-07-2026"), Date.UTC(2026, 6, 30));
  assert.equal(parseVersionDate("", "https://x/bgr_zones_15082026.json"), Date.UTC(2026, 7, 15));
  assert.equal(
    parseVersionDate("BGRZoneVersion 30-07-2026", "https://x/f.zip → z.json"),
    Date.UTC(2026, 6, 30),
    "title date wins even for a zip origin",
  );
  assert.ok(Number.isNaN(parseVersionDate("no date here", "https://x/file.json")));

  assert.equal(isZoneDataset({ features: [] }), false);
  assert.equal(
    isZoneDataset({ features: [{ geometry: [{ horizontalProjection: { type: "Circle" } }] }] }),
    true,
  );

  const currentSha = "aaa";
  const currentDate = Date.UTC(2026, 6, 30);
  assert.equal(
    decideUpdate([{ url: "u1", sha: "bbb", date: Date.UTC(2026, 7, 15) }], currentSha, currentDate)
      ?.url,
    "u1",
    "newer date should update",
  );
  assert.equal(
    decideUpdate([{ url: "u2", sha: "ccc", date: Date.UTC(2026, 5, 1) }], currentSha, currentDate),
    null,
    "older date should not downgrade",
  );
  assert.equal(
    decideUpdate([{ url: "u3", sha: "aaa", date: Date.UTC(2026, 7, 15) }], currentSha, currentDate),
    null,
    "same sha should not update",
  );
  assert.equal(
    decideUpdate([{ url: "u4", sha: "ddd", date: Date.UTC(2026, 6, 30) }], currentSha, currentDate)
      ?.url,
    "u4",
    "same date, changed content should update",
  );

  console.log("self-test: all assertions passed ✓");
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
