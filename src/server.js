// src/server.js — Express app entrypoint.
// Runs locally (`npm start`) and on Vercel via the Docker build.

import express from "express";
import cors from "cors";
import router, { MAX_BODY_BYTES } from "./routes.js";

const app = express();

// The extension sends requests from a chrome-extension:// origin. CORS is
// required because the API is on a different origin than the extension.
// We do not use cookies or credentials, so a permissive origin is acceptable.
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: MAX_BODY_BYTES }));

// Reject malformed JSON with a clear error instead of Express' HTML default.
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      error: `Request body too large. Limit is ${MAX_BODY_BYTES}.`,
    });
  }
  return next(err);
});

app.use("/api", router);

app.get("/", (_req, res) => {
  res.json({ service: "meet-notetaker-backend", status: "ok" });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Final error handler
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error", detail: err?.message });
});

const PORT = process.env.PORT || 3000;

// On Vercel the platform manages the listener; only start a server locally.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[server] Meet Notetaker backend listening on :${PORT}`);
  });
}

export default app;
