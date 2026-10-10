import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import express from "express";
import { hostAllowed, requireLocalHost } from "../server/http-guard.js";

function request(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/ok",
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("host header", () => {
  it("allows only 127.0.0.1 and localhost on the board port", () => {
    assert.equal(hostAllowed("127.0.0.1:4173", 4173), true);
    assert.equal(hostAllowed("localhost:4173", 4173), true);
    assert.equal(hostAllowed(" LocalHost:4173 ", 4173), true);
    assert.equal(hostAllowed("127.0.0.1:4174", 4173), false);
    assert.equal(hostAllowed("evil.example", 4173), false);
    assert.equal(hostAllowed("evil.example:4173", 4173), false);
    assert.equal(hostAllowed("127.0.0.1:4173.evil.test", 4173), false);
    assert.equal(hostAllowed("[::1]:4173", 4173), false);
    assert.equal(hostAllowed(undefined, 4173), false);
    assert.equal(hostAllowed("", 4173), false);
  });

  it("rejects a foreign Host before the route runs", async () => {
    const app = express();
    let port = 0;
    app.use((req, res, next) => requireLocalHost(port)(req, res, next));
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    try {
      const evil = await request(port, "evil.example");
      const rebound = await request(port, `127.0.0.1:${port}.evil.test`);
      const loopback = await request(port, `127.0.0.1:${port}`);
      const local = await request(port, `localhost:${port}`);
      assert.equal(evil.status, 403);
      assert.equal(rebound.status, 403);
      assert.equal(loopback.status, 200);
      assert.equal(local.status, 200);
      assert.match(loopback.body, /"ok":true/);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
