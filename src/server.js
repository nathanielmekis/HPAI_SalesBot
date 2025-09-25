// server.js — express server that serves the Vite frontend and proxies Dify Chatflow (text only)
import http from "http";
import express from "express";
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Resolve filesystem helpers in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const distDir = path.join(rootDir, "dist");

// Decide dev/prod based on presence of dist/ unless NODE_ENV provided
function resolveNodeEnv() {
  if (process.env.NODE_ENV) return process.env.NODE_ENV;
  return fs.existsSync(distDir) ? "production" : "development";
}
const resolvedEnv = resolveNodeEnv();
process.env.NODE_ENV = resolvedEnv;
const isProd = resolvedEnv === "production";
console.log(`[server] Starting in ${resolvedEnv} mode`);

const app = express();
app.use(express.json());

// Minimal CORS for local dev (same-origin in prod)
app.use((req, res, next) => {
  if (!isProd) res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_, res) => res.send("ok"));

/**
 * POST /api/chat
 * Proxies to Dify Chatflow (Advanced Chat) endpoint: POST {base}/v1/chat-messages
 * Required env:
 *  - DIFY_API_KEY      -> Bearer token for the app
 * Optional env:
 *  - DIFY_BASE_URL     -> e.g. https://agent.helport.ai  (no /v1 — we add it)
 *  - DIFY_DEFAULT_USER -> default "web" if not provided by client
 */
app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DIFY_API_KEY not set" });

  try {
    const { query, inputs = {}, conversation_id, user, response_mode } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing required 'query' string" });
    }

    // Normalize base URL (strip any trailing /v1)
    const rawBase = process.env.DIFY_BASE_URL || "https://agent.helport.ai";
    const base = rawBase.replace(/\/v1\/?$/, "");
    const url = `${base}/v1/chat-messages`;

    const body = {
      query,
      inputs,
      conversation_id,
      user: user || process.env.DIFY_DEFAULT_USER || "web",
      response_mode: response_mode || "blocking",
    };

    console.log("Proxying ->", url);
    console.log("Payload:", JSON.stringify(body));

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    // Guard: if upstream sends HTML (error page), return 500 with snippet
    const raw = await upstream.text();
    const ctype = upstream.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      return res.status(upstream.status).type("application/json").send(raw);
    } else {
      console.error("Upstream non-JSON:", upstream.status, ctype, raw.slice(0, 300));
      return res.status(500).json({
        error: "Upstream returned non-JSON",
        status: upstream.status,
        body: raw,
      });
    }
  } catch (err) {
    console.error("Proxy /api/chat error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// --- Frontend (SPA) ---
async function configureFrontend() {
  if (isProd) {
    if (!fs.existsSync(distDir)) {
      console.warn(`Static build not found at ${distDir}. Run "npm run build" before starting in production.`);
    } else {
      app.use(
        express.static(distDir, {
          setHeaders(res, filePath) {
            if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico)$/.test(filePath)) {
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            } else {
              res.setHeader("Cache-Control", "no-cache");
            }
          },
        })
      );
      // SPA fallback (but keep /api/* for API)
      app.get(/^\/(?!api).*/, (req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
      console.log(`[server] Serving static frontend from ${distDir}`);
    }
    return;
  }

  // Dev: use Vite as middleware
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  app.use(/^\/(?!api).*/, async (req, res, next) => {
    try {
      const template = await fs.promises.readFile(path.join(rootDir, "index.html"), "utf-8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (err) {
      vite.ssrFixStacktrace?.(err);
      next(err);
    }
  });
  console.log("[server] Vite dev middleware enabled");
}

await configureFrontend();

// No WebSockets / voice handlers — removed for text-only app

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const server = http.createServer(app);
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} in use. Stop the other process or set PORT to a different value.`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});
