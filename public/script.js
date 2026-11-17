(() => {
  "use strict";

  const API_URL = "/api/chat";
  const MAX_HISTORY = 20; // jumlah pesan terakhir yang dikirim ke model
  const DRAFT_KEY = "chatbot-ai-draft";

  const SYSTEM_PROMPT = {
    role: "system",
    content:
      "Kamu adalah asisten AI yang ramah dan membantu. Jawab dalam bahasa Indonesia, " +
      "kecuali pengguna memakai bahasa lain. Jawab dengan jelas dan ringkas.",
  };

  const SUGGESTIONS = [
    "Jelaskan apa itu REST API",
    "Beri contoh fungsi JavaScript untuk menghitung rata-rata",
    "Tips belajar Express.js untuk pemula",
  ];

  const $ = (id) => document.getElementById(id);
  const log = $("messages");
  const form = $("composer");
  const input = $("input");
  const sendBtn = $("send");
  const newBtn = $("new-chat");
  const head = $("head");
  const status = $("status");

  let history = []; // hanya pesan user dan assistant
  let controller = null;
  let busy = false;
  let session = 0; // naik setiap "Chat baru", supaya balasan lama diabaikan

  /* ================= Render markdown sederhana (aman dari XSS) ================= */

  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const inline = (s) =>
    esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  function blocks(text) {
    const out = [];
    let para = [];
    let list = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      }
      list = null;
    };

    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); flushList(); continue; }

      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const h = line.match(/^#{1,6}\s+(.*)$/);

      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        list = list || { tag, items: [] };
        list.items.push((ul || ol)[1]);
        continue;
      }
      flushList();
      if (h) { flushPara(); out.push(`<p class="h">${inline(h[1])}</p>`); continue; }
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join("");
  }

  function renderMarkdown(src) {
    return src
      .split("```")
      .map((part, i) => {
        if (i % 2 === 0) return blocks(part);
        const code = part.replace(/^[\w+#.-]*\n/, "").replace(/\n$/, ""); // buang nama bahasa
        return `<pre><code>${esc(code)}</code></pre>`;
      })
      .join("");
  }

  /* ================= Tampilan pesan ================= */

  const DOTS = '<span class="dots" aria-label="Mengetik"><i></i><i></i><i></i></span>';

  function addMessage(role, text = "") {
    const wrap = document.createElement("div");
    wrap.className = `msg msg--${role}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (text) bubble.textContent = text;
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return { wrap, bubble };
  }

  function greet() {
    addMessage("bot", "Halo! Ada yang bisa saya bantu?");
    const box = document.createElement("div");
    box.className = "suggest";
    box.id = "suggest";
    SUGGESTIONS.forEach((text) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", () => {
        input.value = text;
        form.requestSubmit();
      });
      box.appendChild(b);
    });
    log.appendChild(box);
  }

  function errorText(status) {
    if (status === 401 || status === 403)
      return "API key OpenRouter ditolak. Pastikan OPENROUTER_API_KEY sudah diisi dengan benar di server.";
    if (status === 429)
      return "Model gratis sedang dibatasi karena terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.";
    if (status === 404)
      return "Model tidak ditemukan atau sedang tidak tersedia di OpenRouter.";
    if (status === 400)
      return "Permintaan ditolak oleh server. Coba kirim pesan yang lebih singkat.";
    if (status >= 500)
      return "Server atau model sedang bermasalah. Coba lagi beberapa saat.";
    return "Tidak dapat terhubung ke server. Periksa koneksi internet, lalu coba lagi.";
  }

  function showError(message, retryText) {
    const { wrap, bubble } = addMessage("bot");
    wrap.classList.add("msg--error");
    bubble.textContent = message;
    if (retryText) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Coba lagi";
      btn.addEventListener("click", () => {
        if (busy) return;
        wrap.remove();
        ask(retryText);
      });
      bubble.appendChild(document.createElement("br"));
      bubble.appendChild(btn);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(state) {
    busy = state;
    head.classList.toggle("is-streaming", state);
    sendBtn.textContent = state ? "Berhenti" : "Kirim";
    sendBtn.classList.toggle("is-stop", state);
    sendBtn.setAttribute("aria-label", state ? "Berhenti bikin jawaban" : "Kirim pesan");
    status.textContent = state ? "Lagi nunggu jawaban dari AI." : "Siap menerima pesan.";
  }

  /* ================= Kirim pesan dan baca streaming ================= */

  async function ask(text) {
    const mine = session;
    setBusy(true);
    history.push({ role: "user", content: text });

    const { wrap, bubble } = addMessage("bot");
    bubble.innerHTML = DOTS;

    controller = new AbortController();
    let full = "";
    let raf = 0;

    const paint = () => {
      raf = 0;
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
      bubble.innerHTML = renderMarkdown(full);
      if (nearBottom) log.scrollTop = log.scrollHeight;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [SYSTEM_PROMPT, ...history.slice(-MAX_HISTORY)] }),
        signal: controller.signal,
      });
      if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });

      bubble.classList.add("is-streaming");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // sisa baris yang belum lengkap

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const { content } = JSON.parse(line.slice(5));
            if (content) { full += content; schedule(); }
          } catch { /* potongan JSON tidak valid, lewati */ }
        }
      }

      if (raf) cancelAnimationFrame(raf);
      if (mine !== session) return;
      if (!full.trim()) throw new Error("empty");
      paint();
      history.push({ role: "assistant", content: full });
    } catch (err) {
      if (raf) cancelAnimationFrame(raf);
      if (mine !== session) return;

      if (full.trim()) {
        // jawaban terputus atau dihentikan: simpan bagian yang sudah diterima
        paint();
        history.push({ role: "assistant", content: full });
        if (err.name !== "AbortError") {
          const note = document.createElement("p");
          note.className = "h";
          note.textContent = "(Jawaban terputus.)";
          bubble.appendChild(note);
        }
      } else {
        wrap.remove();
        history.pop(); // pesan user dibatalkan dari riwayat, agar bisa dicoba ulang
        if (err.name === "AbortError") {
          showError("Pengiriman dihentikan.", text);
        } else if (err.message === "empty") {
          showError("Model tidak mengirim jawaban. Coba lagi.", text);
        } else {
          showError(errorText(err.status || 0), text);
        }
      }
    } finally {
      if (mine === session) {
        bubble.classList.remove("is-streaming");
        setBusy(false);
        controller = null;
        input.focus();
      }
    }
  }

  /* ================= Interaksi ================= */

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  }

  function persistDraft() {
    try {
      if (input.value) {
        localStorage.setItem(DRAFT_KEY, input.value);
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch (error) {
      console.error("Draft pesan nggak bisa disimpan:", error);
      status.textContent = "Draft pesan nggak bisa disimpan di browser ini.";
    }
  }

  function restoreDraft() {
    try {
      input.value = localStorage.getItem(DRAFT_KEY) || "";
      autosize();
    } catch (error) {
      console.error("Draft pesan nggak bisa dibuka:", error);
      status.textContent = "Draft pesan nggak bisa dibuka di browser ini.";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { controller && controller.abort(); return; }

    const text = input.value.trim();
    if (!text) return;

    const suggest = $("suggest");
    if (suggest) suggest.remove();

    input.value = "";
    autosize();
    persistDraft();
    addMessage("user", text);
    ask(text);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    autosize();
    persistDraft();
  });

  newBtn.addEventListener("click", () => {
    session++;
    if (controller) controller.abort();
    controller = null;
    history = [];
    log.innerHTML = "";
    input.value = "";
    autosize();
    persistDraft();
    setBusy(false);
    greet();
    input.focus();
  });

  restoreDraft();
  greet();
})();
