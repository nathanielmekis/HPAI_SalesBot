// server.js - express + websocket server that also serves the Vite frontend
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import "dotenv/config";
import path from "path";
import fs from "fs";
import multer from "multer";
import { fileURLToPath } from "url";
import { Agent } from "undici";
/* eslint-env node */
import process from 'node:process';
import { Buffer } from 'node:buffer';

const TTS_URL = process.env.TTS_URL || "https://69.109.187.61/gpt_api/";
const TTS_INSECURE = process.env.TTS_INSECURE === "1"; // 自签名证书时置 1
const ttsAgent = TTS_INSECURE ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

// Resolve filesystem helpers in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const distDir = path.join(rootDir, "dist");

function resolveNodeEnv() {
  if (process.env.NODE_ENV) return process.env.NODE_ENV;
  return fs.existsSync(distDir) ? "production" : "development";
}

const resolvedEnv = resolveNodeEnv();
process.env.NODE_ENV = resolvedEnv;
const isProd = resolvedEnv === "production";
console.log(`[server] Starting in ${resolvedEnv} mode`);

const app = express();
app.use(express.json({ limit: "10mb" }));

// Minimal CORS for local development (not needed in prod same-origin)
app.use((req, res, next) => {
  if (!isProd) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.get("/health", (_, res) => res.send("ok"));

/* -----------------------------
   1) Proxy endpoint for Dify Chatflow (Advanced Chat)
--------------------------------*/
app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DIFY_API_KEY not set" });

  try {
    const { query, inputs = {}, conversation_id, user, response_mode } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing required 'query' string" });
    }

    const body = {
      query,
      inputs,
      conversation_id,
      user: user || process.env.DIFY_DEFAULT_USER || "web",
      response_mode: response_mode || "blocking",
    };

    const rawBase = process.env.DIFY_BASE_URL || "https://agent.helport.ai";
    const base = rawBase.replace(/\/v1\/?$/, "");
    const url = `${base}/v1/chat-messages`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    const type = upstream.headers.get("content-type") || "";

    if (type.includes("application/json")) {
      return res.status(upstream.status).type("application/json").send(text);
    } else {
      console.error("Upstream non-JSON:", upstream.status, type, text.slice(0, 300));
      return res.status(500).json({
        error: "Upstream returned non-JSON",
        status: upstream.status,
        body: text,
      });
    }
  } catch (err) {
    console.error("Proxy /api/chat error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/* -----------------------------
   2) ASR proxies (Upload + Run)
   POST /api/asr/upload → /v1/files/upload (multipart/form-data)
   POST /api/asr/run    → /v1/workflows/run (application/json)
--------------------------------*/
const ASR_BASE = (process.env.ASR_BASE_URL || "https://agent.helport.ai").replace(/\/v1\/?$/, "");
const ASR_KEY = process.env.ASR_API_KEY; // e.g. "app-9IZw8EwwtwJbdOwyGIEzUNnJ"
if (!ASR_KEY) console.warn("[server] ASR_API_KEY not set — /api/asr/* will 500");

const upload = multer(); // in-memory

// Upload audio file and return {id,...} as-is
app.post("/api/asr/upload", upload.single("file"), async (req, res) => {
  try {
    if (!ASR_KEY) return res.status(500).json({ error: "ASR_API_KEY not set" });
    if (!req.file) return res.status(400).json({ error: "Missing 'file' field" });

    const form = new FormData();
    // keep compatibility with your Postman example
    if (req.body?.user) form.append("user", req.body.user);
    const filename = req.file.originalname || "recording.webm";
    const mime = req.file.mimetype || "application/octet-stream";
    // Node 18+: FormData accepts Blob with filename
    const blob = new Blob([req.file.buffer], { type: mime });
    form.append("file", blob, filename);

    const r = await fetch(`${ASR_BASE}/v1/files/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ASR_KEY}` },
      body: form,
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j || { error: "Upload failed" });
    res.json(j);
  } catch (e) {
    console.error("ASR upload error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Run ASR workflow and return upstream JSON (expects body per your sample)
app.post("/api/asr/run", async (req, res) => {
  try {
    if (!ASR_KEY) return res.status(500).json({ error: "ASR_API_KEY not set" });
    const r = await fetch(`${ASR_BASE}/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ASR_KEY}`,
      },
      body: JSON.stringify(req.body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j || { error: "ASR run failed" });
    res.json(j);
  } catch (e) {
    console.error("ASR run error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text, text_language = "en" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' string" });
    }

    const r = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({ text, text_language }),
      ...(ttsAgent ? { dispatcher: ttsAgent } : {}),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "TTS upstream failed", body: body.slice(0, 400) });
    }

    const ct = r.headers.get("content-type") || "audio/mpeg"; // 可能返回 wav/mp3
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");

    const ab = await r.arrayBuffer();
    res.status(200).end(Buffer.from(ab));
  } catch (e) {
    console.error("TTS proxy error:", e);
    res.status(500).json({ error: String(e) });
  }
});

/* -----------------------------
   3) Frontend (Vite dev or static prod)
--------------------------------*/
async function configureFrontend() {
  if (isProd) {
    if (!fs.existsSync(distDir)) {
      console.warn(
        'Static build not found at ' + distDir + '. Run "npm run build" before starting the server in production.'
      );
      return;
    }

    app.use(
      express.static(distDir, {
        setHeaders(res, filePath) {
          if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico)$/.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
        }
      })
    );

    app.get(/^\/(?!api).*/, (req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });

    console.log(`[server] Serving static frontend from ${distDir}`);
    return;
  }

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

/* -----------------------------
   4) WebSocket (kept minimal/no-op)
   - Keeps session id
   - Echoes a simple lifecycle; no fake transcripts anymore
--------------------------------*/
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/api/voicechat")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2);
  ws.send(JSON.stringify({ type: "session", session_id: sessionId }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // we no longer process audio over WS
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "text") {
        // simple echo to not break any dev tool around WS
        ws.send(JSON.stringify({ type: "partial_answer", text: (msg.text || "").slice(0, 20) }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "final_answer", text: `Reply to: ${msg.text || ""}` }));
          ws.send(JSON.stringify({ type: "done" }));
        }, 150);
      }
      if (msg.type === "start") {
        // acknowledge only
        ws.send(JSON.stringify({ type: "info", text: "WS accepted; audio is handled by REST /api/asr/* now." }));
      }
      if (msg.type === "stop") {
        ws.send(JSON.stringify({ type: "done" }));
      }
    } catch { /* ignore */ }
  });
});

/* -----------------------------
   5) Boot
--------------------------------*/
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} already in use. If another instance is running, stop it or set PORT to a different value.`
    );
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});
