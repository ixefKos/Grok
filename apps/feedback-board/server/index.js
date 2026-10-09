import fs from "node:fs";
import path from "node:path";
import express from "express";
import { appRoot, loadConfig } from "./config.js";
import { addTypedCard, fileCardInTodo, moveCard } from "./cards.js";
import { pullInbox, refreshPullRequests } from "./inbox.js";
import { getRunningCardId, localDay, reconcileInterruptedRuns, runsOnDay, startCardRun, stopAllRuns, stopRun } from "./runs.js";
import { readState } from "./store.js";

const HOST = "127.0.0.1";
const config = loadConfig();
const distDir = path.join(appRoot(), "dist");
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function boardPayload(state) {
  return {
    cards: state.cards,
    agentsEnabled: config.agentsEnabled,
    dailyCap: config.dailyCap,
    runsToday: runsOnDay(state, localDay()),
    runningCardId: getRunningCardId(),
  };
}

function localWrite(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (req.get("X-Feedback-Board") !== "1") {
    res.status(403).json({ error: "This action only comes from the local board." });
    return;
  }
  const origin = req.get("origin");
  const allowedOrigins = new Set([
    `http://${HOST}:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "This action only comes from the local board." });
    return;
  }
  next();
}

app.use("/api", localWrite);

app.get("/api/board", async (_req, res, next) => {
  try {
    res.json(boardPayload(await readState()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards", async (req, res, next) => {
  try {
    const result = await addTypedCard({ title: req.body?.title, notes: req.body?.notes });
    if (!result.ok) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }
    res.status(201).json({ ...boardPayload(result.state), card: result.card });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/cards/:id", async (req, res, next) => {
  try {
    const result = await moveCard(req.params.id, req.body?.column);
    if (!result.ok) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }
    res.json(boardPayload(result.state));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards/:id/start", async (req, res, next) => {
  try {
    const result = config.agentsEnabled
      ? await startCardRun(req.params.id)
      : await fileCardInTodo(req.params.id);
    if (!result.ok) {
      res.status(result.status || 409).json({ error: result.error });
      return;
    }
    const state = result.state || (await readState());
    res.json({
      ...boardPayload(state),
      started: Boolean(config.agentsEnabled && result.spawned),
      notice: config.agentsEnabled ? null : "Agents are off. No run started.",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards/:id/stop", async (req, res, next) => {
  try {
    const result = stopRun(req.params.id);
    if (!result.ok) {
      res.status(result.status || 409).json({ error: result.error });
      return;
    }
    res.json(boardPayload(await readState()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/refresh", async (_req, res, next) => {
  try {
    const inbox = await pullInbox(config);
    const pulls = await refreshPullRequests();
    const errors = [];
    if (!inbox.ok && inbox.error) errors.push(inbox.error);
    if (pulls.errors?.length) errors.push(...pulls.errors);
    res.json({
      ...boardPayload(await readState()),
      added: inbox.added || 0,
      error: errors.length ? errors.join("\n") : null,
    });
  } catch (error) {
    next(error);
  }
});

const indexFile = path.join(distDir, "index.html");
if (fs.existsSync(indexFile)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(indexFile);
  });
}

app.use((error, _req, res, _next) => {
  const message = error && error.message ? error.message : "The board hit an error.";
  res.status(500).json({ error: message });
});

await fs.promises.mkdir(path.join(appRoot(), "data", "runs"), { recursive: true });
await reconcileInterruptedRuns();

const server = app.listen(config.port, HOST, () => {
  console.log(`Feedback board at http://${HOST}:${config.port}`);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

function shutdown() {
  stopAllRuns();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
