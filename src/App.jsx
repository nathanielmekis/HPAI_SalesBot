import React, { useEffect, useRef, useState } from "react";
import { color, motion } from "framer-motion";
import { Mic, Square, Volume2, Loader2, ArrowUp } from "lucide-react";

// Toby Clone Bot – Helport AI
// Apple-inspired voice chat UI with proper logo reference
// Use Vite env to override in dev if you don't set a proxy:
const WS_URL = import.meta.env.VITE_WS_URL || "/api/voicechat";
const ACCENT = "#00C389";
const BG_GRADIENT = `radial-gradient(1200px 600px at 50% -200px, rgba(0,195,137,0.14), transparent),
                     radial-gradient(800px 400px at 90% -100px, rgba(99,102,241,0.10), transparent)`;


// Pick a supported audio mime type (Safari prefers mp4/mpeg)
function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",    // Safari
    "audio/mpeg",   // Safari fallback
  ];
  for (const t of candidates) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
  return ""; // let browser decide
}

export default function App() {
  const [mode, setMode] = useState("voice"); // 'voice' or 'type'
  const [textInput, setTextInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [conversationId, setConversationId] = useState(() => {
    try { return localStorage.getItem("dify_conversation_id") || ""; } catch { return ""; }
  });
  const [status, setStatus] = useState("Ready");

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(/** @type {MediaRecorder|null} */(null));
  const streamRef = useRef(/** @type {MediaStream|null} */(null));
  const audioRef = useRef(null);
  const scrollerRef = useRef(null);
  const API_BASE = import.meta.env.VITE_API_BASE || "";
  const AVATAR_URL = "/toby.png"; // lives in /public
  const START_FRESH_ON_LOAD = true;

  const chunksRef = useRef([]);
  const ASR_USER = "XBOT_DEV"; 

  const ttsCacheRef = useRef(new Map());

  async function speakText(text, lang = "en") {
    if (!text || !audioRef.current) return;
    try {
      // 呈现 Speaking… 状态（不覆盖 Thinking…）
      setStatus(s => (s.includes("Thinking") ? s : "Speaking…"));
  
      // 命中缓存直接播
      let url = ttsCacheRef.current.get(text);
      if (!url) {
        const resp = await fetch(`${API_BASE || ""}/api/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, text_language: lang }),
        });
        if (!resp.ok) throw new Error(`TTS ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const blob = new Blob([buf], { type: resp.headers.get("content-type") || "audio/mpeg" });
        url = URL.createObjectURL(blob);
        ttsCacheRef.current.set(text, url);
      }
  
      audioRef.current.src = url;
      // 播放失败静默（例如用户没交互导致 autoplay 限制）
      await audioRef.current.play().catch(() => {});
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `TTS error: ${e?.message || e}` }]);
    } finally {
      setStatus(s => (s.includes("Thinking") ? s : "Ready"));
    }
  }
  
  // 清理缓存（新对话时用）
  function clearTtsCache() {
    for (const u of ttsCacheRef.current.values()) URL.revokeObjectURL(u);
    ttsCacheRef.current.clear();
  }

  // 结束播放恢复状态（可选）
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onEnd = () => setStatus(s => (s.includes("Thinking") ? s : "Ready"));
    a.addEventListener("ended", onEnd);
    return () => a.removeEventListener("ended", onEnd);
  }, []);

  useEffect(() => {
    if (!START_FRESH_ON_LOAD) return;
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts"); // if you ever added TTL
    } catch {}
    setConversationId("");   // force a new thread
    setMessages([]);         // clear UI
    setStatus("Ready");
  }, []); // runs once after first render

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  // Clean up on unload (stop mic if active)
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks()?.forEach(t => t.stop());
      wsRef.current?.close?.();
    };
  }, []);


  async function handleVoiceClip() {
    try {
      const parts = chunksRef.current;
      chunksRef.current = [];
      if (!parts.length) { setStatus("Ready"); return; }
  
      // 生成 Blob（浏览器实际可能是 webm/opus；后端能吃就行）
      const blob = new Blob(parts, { type: parts[0]?.type || "audio/webm" });
  
      setStatus("Uploading…");
      const fileId = await asrUpload(blob);     // ① 上传，拿 id
      setStatus("Transcribing…");
      const text = await asrRun(fileId);        // ② 调 ASR，拿文本
  
      // 把识别文本当作用户发言插入，然后复用你现有的 runChat
      if (text && text.trim()) {
        setMessages(m => [...m, { role: "user", text }]);
        setStatus("Thinking…");
        await runChat(text);
      } else {
        setMessages(m => [...m, { role: "assistant", text: "ASR returned empty text." }]);
        setStatus("Ready");
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `ASR error: ${e?.message || e}` }]);
      setStatus("Ready");
    }
  }

  async function asrUpload(blob) {
    // POST /api/asr/upload  -> 透传到 https://agent.helport.ai/v1/files/upload
    const form = new FormData();
    form.append("user", "abc123"); // 你示例里的字段
    form.append("file", new File([blob], "recording.webm", { type: blob.type || "audio/webm" }));
  
    const resp = await fetch(`${API_BASE || ""}/api/asr/upload`, { method: "POST", body: form });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const json = await resp.json();
    const fileId = json?.id;
    if (!fileId) throw new Error("Upload OK but no file id.");
    return fileId;
  }
  
  async function asrRun(fileId) {
    // POST /api/asr/run -> 透传到 https://agent.helport.ai/v1/workflows/run
    const payload = {
      inputs: { speech: { transfer_method: "local_file", upload_file_id: fileId, type: "audio" } },
      response_mode: "blocking",
      user: ASR_USER,
    };
    const resp = await fetch(`${API_BASE || ""}/api/asr/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`ASR failed: ${resp.status}`);
    const json = await resp.json();
    return json?.data?.outputs?.text || "";
  }
  
  

  // ----- Start mic + (optionally) WS -----
  const startConversation = async () => {
    try {
      // Mic first (so UI toggles even if WS fails)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = pickAudioMime();
      const opts = mime ? { mimeType: mime } : undefined;
      const mr = new MediaRecorder(stream, opts);
      mediaRecorderRef.current = mr;

      setRecording(true);
      setStatus("Listening…");
      chunksRef.current = [];

      mr.ondataavailable = async (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
+       void handleVoiceClip();
      };

      mr.start(220); // low-latency chunks
    } catch (err) {
      console.error(err);
      setStatus(`Mic error: ${err?.name || err?.message || err}`);
      setRecording(false);
      // Be sure to stop any tracks if partially opened
      streamRef.current?.getTracks()?.forEach(t => t.stop());
      setMode("type"); // switch to type mode on mic fail
    }
  };

  // ----- Send typed message -----
  const sendTextMessage = async () => {
    if (!textInput?.trim()) return;
    // Optimistically append user message
    setMessages(m => {
      // Append user message, then a provisional assistant 'thinking' bubble
      return [...m, { role: "user", text: textInput }, { role: "assistant", text: "Thinking…", provisional: true }];
    });
    setStatus("Thinking…");

    await runChat(textInput);

    setTextInput("");
  };

  // ----- Call Dify Chatflow via server proxy (blocking) -----
  const runChat = async (query) => {
    setStatus("Chatflow…");
    try {
      const body = {
        query: query,
        inputs: {
          // carry forward any app vars you used in workflow, e.g. datasets, toggles, etc.
          qa_dataset_id: "a034b9b4-9b64-40d2-b3c1-951281f84dc6",
        },
        conversation_id: conversationId || undefined,
        user: "Enoch@HELPORT.AI",
        response_mode: "blocking",
      };

      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await resp.json();

      // Dify Chatflow commonly returns: { answer, conversation_id, ... }
      const answer =
        (typeof json?.answer === "string" && json.answer) ||
        (typeof json?.data?.answer === "string" && json.data.answer) ||
        // fallback if a tool returns a structured output
        JSON.stringify(json, null, 2);

      if (json?.conversation_id && json.conversation_id !== conversationId) {
        setConversationId(json.conversation_id);
        try { localStorage.setItem("dify_conversation_id", json.conversation_id); } catch {}
      }

      const finalText = String(answer);
      let targetIndex = -1;
      setMessages((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].provisional) {
            copy[i] = { role: "assistant", text: finalText };
            targetIndex = i;
            break;
          }
        }
        if (targetIndex === -1) {
          copy.push({ role: "assistant", text: finalText });
          targetIndex = copy.length - 1;
        }
        // 等状态更新后再触发播放，避免竞态
        setTimeout(() => speakText(finalText, "en"), 0);
        return copy;
      });
      setStatus("Ready");
    } catch (err) {
      setMessages((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].provisional) {
            copy[i] = { role: "assistant", text: `Chatflow error: ${err?.message || err}` };
            return copy;
          }
        }
        return [...m, { role: "assistant", text: `Chatflow error: ${err?.message || err}` }];
      });
      setStatus(`Chatflow error: ${err?.message || err}`);
    }
  };


  // ----- End mic -----
  const endConversation = () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    // Stop all tracks to release mic light in the browser UI
    streamRef.current?.getTracks()?.forEach(t => t.stop());
    streamRef.current = null;
    setRecording(false);
  };

  // put inside your App component
  const newConversation = () => {
    // Stop mic cleanly if recording
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    streamRef.current?.getTracks()?.forEach(t => t.stop());
    streamRef.current = null;
    setRecording(false);

    // Optionally close the WS session (not required for Dify new chat, but tidy)
    try { wsRef.current?.close?.(); } catch {}

    // Clear persisted conversation id (and any timestamp you might add later)
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts"); // if you adopt TTL later
    } catch {}

    // Reset UI state
    clearTtsCache();
    setConversationId("");
    setMessages([]);
    setStatus("Ready");
  };

  // ====== NEW: minimal helpers to meet your two UI requirements ======
  // Derived status: hide "Ready/Listening" when in Type mode; only show when thinking
  const displayStatus =
    mode === "type" ? (status.includes("Thinking") ? status : "") : status;

  const statusIcon = () => {
    if (!displayStatus) return null;
    if (displayStatus.includes("Listening")) return <Mic size={14} />;
    if (displayStatus.includes("Thinking") || displayStatus.includes("Chatflow"))
      return <Loader2 size={14} className="animate-spin" />;
    return <Volume2 size={14} />;
  };

  // Mode switches: when entering Type, stop mic and clear idle status
  const switchToVoice = () => setMode("voice");
  const switchToType = () => {
    if (recording) endConversation();
    setMode("type");
    if (!status.includes("Thinking")) setStatus("");
  };

  // Mode-aware empty-state copy
  const EmptyHint = () => (
    <div style={styles.emptyText}>
      {mode === "voice" ? (
        <>
          Click <span style={{ fontWeight: 600, color: ACCENT }}>Start conversation</span> and speak — we’ll transcribe, retrieve, and reply.
        </>
      ) : (
        <>
          <div>
            Type a question below and press <span style={{ fontWeight: 600, color: ACCENT }}>Enter</span> — we’ll retrieve and reply.
          </div>
        </>
      )}
    </div>
  );
  // ================================================================

  // ----- Styles -----
  const styles = {
    page: {
      minHeight: "100vh",
      backgroundImage: BG_GRADIENT,
      backgroundColor: "#ffffff",
      color: "#0a0a0a",
      display: "flex",
      flexDirection: "column",
    },
    topbar: {
      maxWidth: 1100,
      width: "100%",
      margin: "0 auto",
      padding: "24px 20px",
      display: "flex",
      alignItems: "center",
      gap: 12,
    },
    brand: { height: 36 },
    spacer: { marginLeft: "auto", fontSize: 12, opacity: 0.6 },
    hero: { maxWidth: 820, width: "100%", margin: "0 auto 16px", padding: "0 20px", textAlign: "center" },
    h1: { fontSize: 36, fontWeight: 600, letterSpacing: -0.4, margin: 0 },
    p: { marginTop: 8, opacity: 0.7 },
    cardWrap: { maxWidth: 820, width: "100%", margin: "0 auto", padding: "0 20px" },
    card: {
      borderRadius: 24,
      border: "2px solid rgba(0,0,0,0.08)",
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.06)",
      overflow: "hidden",
    },
    scroll: { height: "56vh", overflowY: "auto", padding: 20 },
    emptyText: { opacity: 0.6, fontSize: 18, textAlign: 'center' },
    row: (justify) => ({ display: "flex", justifyContent: justify, marginBottom: 10 }),
    bubble: (me, provisional) => ({
      background: me ? ACCENT : "rgba(255,255,255,0.95)",
      color: me ? "white" : "#0a0a0a",
      borderRadius: 18,
      padding: "10px 14px",
      maxWidth: "85%",
      boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      whiteSpace: "pre-wrap",
      opacity: provisional ? 0.7 : 1,          // <— dim while provisional
      fontStyle: provisional ? "italic" : "normal",
    }),
    controls: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between", // push apart
      padding: 16,
      borderTop: "1px solid rgba(0,0,0,0.08)",
    },
    cta: (danger) => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      border: "none",
      borderRadius: 30,
      padding: "12px 18px",
      fontSize: 14,
      fontWeight: 600,
      color: "#fff",
      background: danger ? "#ff453a" : ACCENT,
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    }),
    status: { fontSize: 12, opacity: 0.7, display: "inline-flex", alignItems: "center", gap: 6 },
    footer: { maxWidth: 1100, width: "100%", margin: "0 auto", padding: "32px 20px", textAlign: "center", fontSize: 12, opacity: 0.6 },

    avatar: {
      width: 50,
      height: 50,
      borderRadius: "50%",
      flex: "0 0 36px",
      objectFit: "cover",
      boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
      marginRight: 10,              // space between avatar and bubble
    },
    rowWithAvatar: {
      display: "flex",
      alignItems: "flex-start",
      gap: 0,
      marginBottom: 10,
    },

    input: {
      padding: "14px 16px",
      borderRadius: 20,
      minWidth: 300,
      outline: "none",                     
      transition: "border-color .15s, box-shadow .15s",
      fontWeight: 400,
      color: "#0a0a0a",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
      border: `1px solid ${ACCENT}`
    },
    inputFocused: {
      border: `1px solid ${ACCENT}`,       // green border
      boxShadow: `0 0 0 4px rgba(0,195,137,0.15) inset`, // soft glow
    },

    // in styles
    toggle: {
      display: "flex",
      alignItems: "center",
      border: `1px solid ${ACCENT}`,
      borderRadius: 30,
      overflow: "hidden",
      background: "#ffffff",
      position: "relative",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    },
    toggleBtn: {
      flex: 1,
      minWidth: 0,
      padding: "12px 18px",      
      fontSize: 14,
      fontWeight: 600,
      border: "none",
      background: "transparent",
      color: ACCENT,
      cursor: "pointer",
      lineHeight: 1,
      textAlign: "center",
      outline: "none",
      boxShadow: "none",
    },
    toggleBtnActive: {
      background: ACCENT,
      color: "#ffffff",
    },

    toggleBtnLeftPad:  { padding: "12px 22px 12px 18px" },  // a touch more right pad
    toggleBtnRightPad: { padding: "12px 18px 12px 22px" },  // a touch more left pad

  };

  return (
    <div style={styles.page}>
      {/* Top Bar */}
      <div style={styles.topbar}>
        {/* Put your logo at public/helport.png */}
        <img src="/helport.png" alt="Helport AI" style={styles.brand} />
        <div style={styles.spacer}>Session: {sessionId || "new"} · {connected ? "Online" : "Offline"}</div>
      </div>

      {/* Hero */}
      <section style={styles.hero}>
        <motion.h1 initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.h1}>Toby Clone Bot</motion.h1>
        <motion.p initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.p}>
          Voice demo of our sales knowledge base — ask anything and hear the answer in Toby&apos;s voice.
        </motion.p>
      </section>

      {/* Card */}
      <main style={styles.cardWrap}>
        <div style={styles.card}>
          {/* Chat Scroll */}
          <div ref={scrollerRef} style={styles.scroll}>
            {messages.length === 0 ? (
              <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
                <EmptyHint />
              </div>
            ) : (
              <div>
                {messages.map((m, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={m.role === "assistant" ? styles.rowWithAvatar : styles.row("flex-end")}
                  >
                    {m.role === "assistant" && <img src={AVATAR_URL} alt="Agent" style={styles.avatar} />}

                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={styles.bubble(m.role === "user", m.provisional)}>
                      {m.text}
                    </div>
                    {m.role === "assistant" && !m.provisional && (
                      <button
                        onClick={() => speakText(m.text, "en")}
                        title="Replay"
                        style={{
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          padding: 4,
                          opacity: 0.7
                        }}
                        aria-label="Replay audio"
                      >
                        <Volume2 size={16} />
                      </button>
                    )}
                  </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div style={styles.controls}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={styles.toggle} role="tablist" aria-label="Input mode">
                <button
                  role="tab"
                  aria-selected={mode === "voice"}
                  onClick={switchToVoice}
                  style={{ ...styles.toggleBtn, ...(mode === "voice" ? styles.toggleBtnActive : null) }}
                >
                  Voice
                </button>
                <div aria-hidden style={styles.toggleDivider} />
                <button
                  role="tab"
                  aria-selected={mode === "type"}
                  onClick={switchToType}
                  style={{ ...styles.toggleBtn, ...(mode === "type" ? styles.toggleBtnActive : null), ...styles.toggleBtnRightPad, ...styles.toggleBtnLeftPad }}
                >
                  Text
                </button>
              </div>
              {displayStatus && (
                <span style={styles.status}>
                  {statusIcon()}
                  {displayStatus}
                </span>
              )}
            </div>

            {/* Controls: either show recording CTA or text input depending on mode */}
            {mode === "voice" ? (
              <button
                onClick={recording ? endConversation : startConversation}
                style={styles.cta(recording)}
                aria-label={recording ? "End conversation" : "Start conversation"}
              >
                {recording ? <Square size={16}/> : <Mic size={16}/>} {recording ? "End conversation" : "Start conversation"}
              </button>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendTextMessage(); }}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  placeholder="Type your question and press Enter"
                  style={{ ...styles.input, ...(inputFocused ? styles.inputFocused : null) }}
                />

                <button onClick={sendTextMessage} style={styles.cta(false)} aria-label="Send message">
                  <ArrowUp size={16} />
                </button>
              </div>
            )}
            <button
              onClick={newConversation}
              style={{ ...styles.cta(false), background: '#ffffff', color: ACCENT, border: `1px solid ${ACCENT}` }}
              aria-label="Start a new conversation"
            >
              New conversation
            </button>
          </div>
        </div>
      </main>

      <audio ref={audioRef} preload="auto" />

      {/* Footer */}
      <footer style={styles.footer}>
        © {new Date().getFullYear()} Helport AI · Built for live demos · Voice: top-sales-voice-001
      </footer>
    </div>
  );
}