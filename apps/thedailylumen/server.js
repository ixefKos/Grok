import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4174;
const files = {
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/favicon.svg": { name: "favicon.svg", type: "image/svg+xml" },
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  const file = files[pathname === "/" ? "/index.html" : pathname];
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": file.type });
  res.end(fs.readFileSync(path.join(dir, file.name)));
});

server.listen(port, host, () => {
  console.log(`Daily Lumen preview at http://${host}:${port}`);
});
