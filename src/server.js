// server.js - express + websocket server that also serves the Vite frontend
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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
app.use(express.json());

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

// Proxy endpoint for Dify Chatflow (Advanced Chat)
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

    // Normalize base URL: ensure NO trailing /v1 (we add it)
    const rawBase = process.env.DIFY_BASE_URL || "https://agent.helport.ai";
    const base = rawBase.replace(/\/v1\/?$/, "");
    const url = `${base}/v1/chat-messages`; // Chatflow endpoint

    console.log("Proxying ->", url, "status: pending");
    console.log("Payload:", JSON.stringify(body));

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

async function configureFrontend() {
  if (isProd) {
    if (!fs.existsSync(distDir)) {
      console.warn("Static build not found at " + distDir + ". Run \"npm run build\" before starting the server in production.");
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
        },
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
    server: {
      middlewareMode: true,
    },
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

  let collecting = false;
  let audioBytes = 0;
  let partialTimer = null;
  const parts = ["What ", "programs ", "can you ", "offer me ", "today?"];
  let i = 0;

  function stopStreaming() {
    if (partialTimer) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  }

  ws.on("close", () => stopStreaming());

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (collecting) audioBytes += data.length;
      return;
    }

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "text") {
        ws.send(
          JSON.stringify({
            type: "partial_answer",
            text: msg.text.slice(0, 20) + (msg.text.length > 20 ? "..." : ""),
          })
        );
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "final_answer", text: `Reply to: ${msg.text}` }));
          ws.send(
            JSON.stringify({
              type: "tts_url",
              url: "https://actions.google.com/sounds/v1/alarms/beep_short.ogg",
            })
          );
          ws.send(JSON.stringify({ type: "done" }));
        }, 250);
        return;
      }

      if (msg.type === "start") {
        collecting = true;
        audioBytes = 0;
        i = 0;
        stopStreaming();

        partialTimer = setInterval(() => {
          if (!collecting) return;
          if (i < parts.length) {
            ws.send(
              JSON.stringify({
                type: "partial_transcript",
                text: parts.slice(0, i + 1).join(""),
              })
            );
            i++;
          } else {
            ws.send(
              JSON.stringify({
                type: "partial_transcript",
                text: parts.join(""),
              })
            );
          }
        }, 150);
      } else if (msg.type === "stop") {
        collecting = false;
        stopStreaming();

        const finalText = parts.join("");
        ws.send(JSON.stringify({ type: "final_transcript", text: finalText }));

        ws.send(
          JSON.stringify({
            type: "partial_answer",
            text: "We can walk you through a few options...",
          })
        );
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "final_answer",
              text: "Here are a few common programs...\n- Conventional\n- FHA\n- VA\n- Cash-out refi",
            })
          );
          ws.send(
            JSON.stringify({
              type: "tts_url",
              url: "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg",
            })
          );
          ws.send(JSON.stringify({ type: "done" }));
        }, 400);
      }
    } catch {}
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => console.log(`Mock WS server on http://localhost:${PORT}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. If another instance is running, stop it or set PORT to a different value.`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});
