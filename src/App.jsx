import React, { useEffect, useRef, useState } from "react";
import { m, motion } from "framer-motion";
import { Loader2, ArrowUp } from "lucide-react";

// Text-only Toby Clone Bot – Helport AI
const ACCENT = "#00C389";
const BG_GRADIENT = `radial-gradient(1200px 600px at 50% -200px, rgba(0,195,137,0.14), transparent),
                     radial-gradient(800px 400px at 90% -100px, rgba(99,102,241,0.10), transparent)`;

export default function App() {
  const [textInput, setTextInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("Ready");
  const [inputFocused, setInputFocused] = useState(false);
  const [conversationId, setConversationId] = useState(() => {
    try { return localStorage.getItem("dify_conversation_id") || ""; } catch { return ""; }
  });

  const scrollerRef = useRef(null);
  const API_BASE = import.meta.env.VITE_API_BASE || "";
  const AVATAR_URL = "/helportapplogo.png";
  const START_FRESH_ON_LOAD = true;

  // Start fresh each load (new conversation)
  useEffect(() => {
    if (!START_FRESH_ON_LOAD) return;
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts");
    } catch {}
    setConversationId("");
    setMessages([]);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // --- helpers for a minimal local history (optional keep) ---
  const LS_INDEX = "dify_convo_index_v1";
  const convoKey = (id) => `dify_conversation_cache::${id}`;
  const loadIndex = () => { try { return JSON.parse(localStorage.getItem(LS_INDEX) || "[]"); } catch { return []; } };
  const saveIndex = (list) => { try { localStorage.setItem(LS_INDEX, JSON.stringify(list)); } catch {} };
  const saveConversationSnapshot = (id, title, msgs) => {
    if (!id) return;
    try { localStorage.setItem(convoKey(id), JSON.stringify(msgs)); } catch {}
    const now = Date.now();
    const idx = loadIndex();
    const firstUser = msgs.find(m => m.role === "user")?.text;
    const name = title || (firstUser ? firstUser.slice(0, 60) : "Untitled conversation");
    const existing = idx.find(x => x.id === id);
    if (existing) { existing.title = name; existing.updated = now; }
    else { idx.push({ id, title: name, updated: now }); }
    idx.sort((a,b)=> (b.updated||0)-(a.updated||0));
    saveIndex(idx);
  };
  // -----------------------------------------------------------

  const sendTextMessage = async () => {
    if (!textInput.trim()) return;
    // optimistic UI
    setMessages(m => [...m, { role: "user", text: textInput }, { role: "assistant", text: "Thinking…", provisional: true }]);
    setStatus("Thinking…");
    const userText = textInput;
    setTextInput("");
    await runChat(userText);
  };

  const runChat = async (query) => {
    setStatus("Chatflow…");
    try {
      const body = {
        query,
        inputs: { qa_dataset_id: "a034b9b4-9b64-40d2-b3c1-951281f84dc6" },
        conversation_id: conversationId || undefined,
        user: "Enoch@HELPORT.AI",
        response_mode: "blocking",
      };

      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // If upstream ever returns HTML, this will throw and we surface the error bubble.
      const json = await resp.json();

      const answer =
        (typeof json?.answer === "string" && json.answer) ||
        (typeof json?.data?.answer === "string" && json.data.answer) ||
        JSON.stringify(json, null, 2);

      if (json?.conversation_id && json.conversation_id !== conversationId) {
        setConversationId(json.conversation_id);
        try { localStorage.setItem("dify_conversation_id", json.conversation_id); } catch {}
      }

      setMessages((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].provisional) {
            copy[i] = { role: "assistant", text: String(answer) };
            try {
              const idToUse = json?.conversation_id || conversationId;
              if (idToUse) saveConversationSnapshot(idToUse, json?.conversation_name, copy);
            } catch {}
            return copy;
          }
        }
        const next = [...m, { role: "assistant", text: String(answer) }];
        try {
          const idToUse = json?.conversation_id || conversationId;
          if (idToUse) saveConversationSnapshot(idToUse, json?.conversation_name, next);
        } catch {}
        return next;
      });

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
    }
  };

  const newConversation = () => {
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts");
    } catch {}
    setConversationId("");
    setMessages([]);
  };

  // --- styles ---
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
    },
    brand: { height: 55, display: "inline-block"},
    brandNudge: { transform: "translateY(10px)" },
    spacer: { marginLeft: "auto", fontSize: 12, opacity: 0.6 },
    hero: { maxWidth: 820, width: "100%", margin: "0 auto 16px", padding: "0 20px", textAlign: "center" },
    h1: { fontSize: 48, fontWeight: 600, letterSpacing: -0.4, margin: 0 },
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
    scroll: {
      height: "56vh",
      overflowY: "auto",
      padding: 20,
      scrollbarWidth: "thin",
      scrollbarColor: ACCENT + " rgba(0,0,0,0.08)",
      scrollbarGutter: "stable",
    },
    emptyText: { opacity: 0.6, fontSize: 18, textAlign: "center" },
    row: (justify) => ({ display: "flex", justifyContent: justify, marginBottom: 10 }),
    rowWithAvatar: { display: "flex", alignItems: "flex-start", gap: 0, marginBottom: 10 },
    avatar: { width: 50, height: 50, borderRadius: "50%", flex: "0 0 36px", objectFit: "cover", boxShadow: "0 2px 6px rgba(0,0,0,0.12)", marginRight: 10 },
    bubble: (me, provisional) => ({
      background: me ? ACCENT : "rgba(255,255,255,0.95)",
      color: me ? "white" : "#0a0a0a",
      borderRadius: 18,
      padding: "10px 14px",
      maxWidth: "85%",
      boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      whiteSpace: "pre-wrap",
      opacity: provisional ? 0.7 : 1,
      fontStyle: provisional ? "italic" : "normal",
    }),

    controls: {
      borderTop: "1px solid rgba(0,0,0,0.08)",
      padding: "16px 20px",
    },

    // full-width bar
    bar: {
      display: "flex",
      alignItems: "center",
      gap: 12,
    },

    // left side grows; right side stays content-width
    leftWrap: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flex: 1,          // ⬅️ take all available space
      minWidth: 0,      // ⬅️ allow shrinking without overflow
    },

    input: {
      flex: 1,          // ⬅️ stretch across leftWrap
      minWidth: 0,      // ⬅️ prevent overflow on narrow screens
      padding: "14px 16px",
      borderRadius: 20,
      outline: "none",
      border: `1px solid ${ACCENT}`,
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
      background: "#fff",
    },
    inputFocused: {
      border: `1px solid ${ACCENT}`,
      boxShadow: `0 0 0 4px rgba(0,195,137,0.15) inset`,
    },

    cta: (danger) => ({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      height: 48,
      padding: "0 18px",
      border: "1px solid transparent",
      borderRadius: 9999,
      fontSize: 14,
      fontWeight: 600,
      color: "#fff",
      background: danger ? "#ff453a" : ACCENT,
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
      whiteSpace: "nowrap",
    }),

    // outline style for the right pill, to match your UI
    ctaOutline: {
      color: ACCENT,
      background: "#ffffff",
      border: `1px solid ${ACCENT}`,
    },

    ghostBtn: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      borderRadius: 30,
      padding: "12px 18px",
      fontSize: 14,
      fontWeight: 600,
      color: ACCENT,
      background: "#ffffff",
      border: `1px solid ${ACCENT}`,
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
    },
    footer: { maxWidth: 1100, width: "100%", margin: "0 auto", padding: "32px 20px", textAlign: "center", fontSize: 12, opacity: 0.6 },
  };

  return (
    <div style={styles.page}>
      <div style={{ height: "40px" }}></div>


      {/* Hero */}
      <section style={styles.hero}>
        <motion.h1 initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.h1}> <img src="/helport.png" alt="Helport AI" style={{ ...styles.brand, ...styles.brandNudge }} /> Bot</motion.h1>
        <motion.p initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.p}>
          Ask anything about our company.
        </motion.p>
      </section>

      {/* Card */}
      <main style={styles.cardWrap}>
        <div style={styles.card}>
          {/* Chat Scroll */}
          <div ref={scrollerRef} style={styles.scroll} className="chat-scroll">
            {messages.length === 0 ? (
              <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
                <div style={styles.emptyText}>
                  Type a question below and press <span style={{ fontWeight: 600, color: ACCENT }}>Enter</span>.
                </div>
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
                    <div style={styles.bubble(m.role === "user", m.provisional)}>{m.text}</div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          <div style={styles.controls}>
            <div style={styles.bar}>
              {/* LEFT (flex:1) — input + send */}
              <div style={styles.leftWrap}>
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendTextMessage(); }}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  placeholder="Type your question and press Enter"
                  style={{ ...styles.input, ...(inputFocused ? styles.inputFocused : null) }}
                />
                <button
                  onClick={sendTextMessage}
                  style={styles.cta(false)}
                  aria-label="Send message"
                >
                  <ArrowUp size={16} />
                </button>
              </div>

              {/* RIGHT — stays snug to the right */}
              <button
                onClick={newConversation}
                style={{ ...styles.cta(false), ...styles.ctaOutline }}
                aria-label="Start a new conversation"
              >
                New conversation
              </button>
            </div>
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer style={styles.footer}>
        © {new Date().getFullYear()} Helport AI · Built for live demos
      </footer>
    </div>
  );
}
