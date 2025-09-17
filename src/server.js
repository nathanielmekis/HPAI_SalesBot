// server.js - tiny mock WS backend for /api/voicechat
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.get("/health", (_, res) => res.send("ok"));

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/voicechat") {
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

      if (msg.type === "start") {
        collecting = true;
        audioBytes = 0;
        i = 0;
        stopStreaming();

        // STREAM partial transcripts while recording
        partialTimer = setInterval(() => {
          if (!collecting) return;
          if (i < parts.length) {
            ws.send(JSON.stringify({
              type: "partial_transcript",
              text: parts.slice(0, i + 1).join("")
            }));
            i++;
          } else {
            // Loop a bit or hold last partial; we’ll finalize on stop
            ws.send(JSON.stringify({
              type: "partial_transcript",
              text: parts.join("")
            }));
          }
        }, 150);
      }

      else if (msg.type === "stop") {
        collecting = false;
        stopStreaming();

        // Final user text
        const finalText = parts.join("");
        ws.send(JSON.stringify({ type: "final_transcript", text: finalText }));

        // Assistant streams, then finalizes
        ws.send(JSON.stringify({ type: "partial_answer", text: "We can walk you through a few options…" }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "final_answer",
            text: "Here are a few common programs...\n• Conventional\n• FHA\n• VA\n• Cash-out refi"
          }));
          ws.send(JSON.stringify({
            type: "tts_url",
            url: "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"
          }));
          ws.send(JSON.stringify({ type: "done" }));
        }, 400);
      }
    } catch {}
  });
});


const PORT = 3001;
server.listen(PORT, () => console.log(`Mock WS server on http://localhost:${PORT}`));
