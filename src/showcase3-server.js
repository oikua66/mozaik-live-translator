import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.SHOWCASE3_PORT || 3002);
const root = fileURLToPath(new URL("../public-showcase3/", import.meta.url));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function proxy(req, res, { port, prefix }) {
  const upstreamPath = req.url.slice(prefix.length) || "/";
  const headers = { ...req.headers, host: `localhost:${port}` };
  const upstream = http.request({
    hostname: "127.0.0.1",
    port,
    path: upstreamPath,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders["content-security-policy"];
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `Backend on port ${port} is unavailable: ${error.message}` }));
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = requestPath.split("?")[0].replace(/\.\./g, "");
  try {
    const data = await readFile(pathJoin(root, safePath));
    res.writeHead(200, { "content-type": mime[extname(safePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/network-api/")) {
    req.url = req.url.replace(/^\/network-api/, "/api");
    return proxy(req, res, { port: 3001, prefix: "" });
  }
  if (req.url?.startsWith("/voice-api/")) {
    req.url = req.url.replace(/^\/voice-api/, "/api");
    return proxy(req, res, { port: 3000, prefix: "" });
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n🎬 Unified Corporate Agent Showcase: http://localhost:${PORT}`);
  console.log("Uses existing backends unchanged: network 3001 + voice 3000.\n");
});
