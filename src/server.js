// server.js — simple prod-ready server with a mock /api/voicechat WS and /api/chat proxy
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Minimal CORS for local dev (not needed in prod same-origin)
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
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

// -------- Proxy to Dify Chatflow ----------
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

    const baseUrl = process.env.DIFY_BASE_URL || "https://agent.helport.ai";
    const resp = await fetch(`${baseUrl}/v1/chat-messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    // If Dify returns HTML (e.g., auth error proxied by nginx), force JSON error
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      return res.status(resp.status).json(json);
    } catch {
      return res
        .status(500)
        .json({ error: "Upstream returned non-JSON", status: resp.status, body: text.slice(0, 400) });
    }
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// -------- Static SPA (Vite build) ----------
const distDir = path.join(__dirname, "..", "dist");
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

// SPA fallback that skips /api
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

// -------- WebSocket mock for /api/voicechat ----------
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
  let partialTimer = null;
  const parts = ["What ", "programs ", "can you ", "offer me ", "today?"];
  let i = 0;

  const stopStreaming = () => {
    if (partialTimer) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  };

  ws.on("close", stopStreaming);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "text") {
      ws.send(
        JSON.stringify({
          type: "partial_answer",
          text: msg.text.slice(0, 20) + (msg.text.length > 20 ? "…" : ""),
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
      i = 0;
      stopStreaming();
      partialTimer = setInterval(() => {
        if (!collecting) return;
        if (i < parts.length) {
          ws.send(JSON.stringify({ type: "partial_transcript", text: parts.slice(0, i + 1).join("") }));
          i++;
        } else {
          ws.send(JSON.stringify({ type: "partial_transcript", text: parts.join("") }));
        }
      }, 150);
      return;
    }

    if (msg.type === "stop") {
      collecting = false;
      stopStreaming();
      const finalText = parts.join("");
      ws.send(JSON.stringify({ type: "final_transcript", text: finalText }));

      ws.send(JSON.stringify({ type: "partial_answer", text: "We can walk you through a few options…" }));
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "final_answer",
            text: "Here are a few common programs...\n• Conventional\n• FHA\n• VA\n• Cash-out refi",
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
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use.`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});
