import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4174;
const page = fs.readFileSync(path.join(dir, "index.html"));

const server = http.createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url;
  if (url !== "/index.html") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});

server.listen(port, host, () => {
  console.log(`Daily Lumen preview at http://${host}:${port}`);
});
