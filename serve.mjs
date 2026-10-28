import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4173;
const url = `http://127.0.0.1:${port}/`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".kml": "application/vnd.google-earth.kml+xml; charset=utf-8",
};

function openBrowser(targetUrl) {
  if (process.env.NO_OPEN) return;
  if (process.platform === "win32") {
    exec(`start "" "${targetUrl}"`);
  } else if (process.platform === "darwin") {
    exec(`open "${targetUrl}"`);
  } else {
    exec(`xdg-open "${targetUrl}"`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";

  const file = path.normalize(path.join(root, urlPath));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": stat.size,
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`WildVolt 已經在執行中，直接為您開啟瀏覽器：${url}`);
    openBrowser(url);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`==================================================`);
  console.log(`  野電計畫 WildVolt 已啟動：${url}`);
  console.log(`  （關閉此視窗或按 Ctrl+C 即可停止伺服器）`);
  console.log(`==================================================`);
  openBrowser(url);
});
