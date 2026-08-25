#!/usr/bin/env node
/**
 * Minimal zero-dependency static file server for local preview.
 * Serves ./public on http://localhost:8788
 *
 * Usage:  npm run dev
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "public");
const port = process.env.PORT || 8788;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    // Prevent path traversal.
    const filePath = normalize(join(rootDir, path));
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, () => {
  console.log(`Serving public/ at http://localhost:${port}`);
});
