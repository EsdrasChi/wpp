// ═══════════════════════════════════════════
//  WPP OUTBOUND — Frontend Application
// ═══════════════════════════════════════════

const socket = io();
let currentView = "inbox";
let currentChatJid = null;
let chats = [];
let leads = [];
let sessions = {};
let qrModalSession = null;
let contactTab = "pending"; // "pending" ou "contacted"
let pickerContact = null; // contato selecionado no modal

const INSTANCE_COLORS = {
  "session-1": { bg: "inst-badge-1", label: "S1" },
  "session-2": { bg: "inst-badge-2", label: "S2" },
  "session-3": { bg: "inst-badge-3", label: "S3" },
  "session-4": { bg: "inst-badge-4", label: "S4" },
  "session-5": { bg: "inst-badge-5", label: "S5" },
};

// ─── Navigation ──────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${view}`).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-nav="${view}"]`)?.classList.add("active");

  if (view === "instances") renderInstances();
  if (view === "contacts") renderContactsView();
}

// ─── Socket Events ───────────────────────
socket.on("sessions:all", (data) => {
  sessions = data;
  renderSidebarInstances();
  renderInstances();
  populateSessionDropdowns();
});

socket.on("session:status", (data) => {
  if (!sessions[data.sessionId]) {
    sessions[data.sessionId] = {};
  }
  sessions[data.sessionId].status = data.status;
  sessions[data.sessionId].jid = data.jid;
  sessions[data.sessionId].name = data.name;
  sessions[data.sessionId].customName = data.customName;
  sessions[data.sessionId].phone = data.phone;
  renderSidebarInstances();
  if (currentView === "instances") renderInstances();
  populateSessionDropdowns();

  if (data.status === "open" && qrModalSession === data.sessionId) {
    closeQRModal();
  }
});

socket.on("qr:update", (data) => {
  if (qrModalSession === data.sessionId) {
    document.getElementById("qr-image").src = data.qr;
  }
  // auto-open modal if user initiated
  if (sessions[data.sessionId]?._waitingQR) {
    qrModalSession = data.sessionId;
    const idx = data.sessionId.split("-")[1];
    document.getElementById("qr-modal-title").textContent = `Instância ${idx} — Escanear QR`;
    document.getElementById("qr-image").src = data.qr;
    document.getElementById("qr-modal").classList.remove("hidden");
    sessions[data.sessionId]._waitingQR = false;
  }
});

socket.on("chats:list", (data) => {
  chats = data;
  renderChatList();
});

socket.on("message:new", (data) => {
  // Atualizar chat list
  socket.emit("chats:refresh");

  // Se o chat está aberto, adicionar mensagem
  if (data.message.chatJid === currentChatJid) {
    appendMessage(data.message);
    scrollMessagesToBottom();
  }
});

socket.on("chat:messages", (data) => {
  if (data.jid === currentChatJid) {
    renderMessages(data.messages);
  }
});

socket.on("message:sent", (data) => {
  if (data.success) {
    document.getElementById("chat-input").value = "";
  }
});

// ─── Sidebar Instances ──────────────────
function renderSidebarInstances() {
  const el = document.getElementById("sidebar-instances");
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const id = `session-${i}`;
    const s = sessions[id] || { status: "disconnected" };
    const statusClass = `status-${s.status || "disconnected"}`;
    const statusLabel = {
      open: "Online",
      connecting: "Conectando",
      qr: "Aguardando QR",
      reconnecting: "Reconectando",
      disconnected: "Offline",
      error: "Erro",
    }[s.status] || "Offline";

    const displayName = s.customName || s.name || `Instância ${i}`;
    const phoneDisplay = s.phone ? `<span class="text-[10px] text-gray-600 block truncate">${s.phone}</span>` : "";

    html += `
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors">
        <div class="status-dot ${statusClass}"></div>
        <span class="inst-badge ${INSTANCE_COLORS[id].bg}">${INSTANCE_COLORS[id].label}</span>
        <div class="flex-1 min-w-0">
          <span class="text-xs text-gray-400 block truncate">${escapeHtml(displayName)}</span>
          ${phoneDisplay}
        </div>
        <span class="text-[10px] text-gray-600 shrink-0">${statusLabel}</span>
      </div>
    `;
  }
  el.innerHTML = html;
}

// ─── Instances Grid ─────────────────────
function renderInstances() {
  const el = document.getElementById("instances-grid");
  if (!el) return;
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const id = `session-${i}`;
    const s = sessions[id] || { status: "disconnected" };
    const isConnected = s.status === "open";
    const statusClass = `status-${s.status || "disconnected"}`;

    const displayName = s.customName || `Instância ${i}`;
    const phoneText = s.phone || "Nenhum telefone conectado";

    html += `
      <div class="bg-surface-900 border border-white/5 rounded-xl p-5 hover:border-white/10 transition-colors">
        <!-- Header com badge e status -->
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <span class="inst-badge ${INSTANCE_COLORS[id].bg} text-xs">${INSTANCE_COLORS[id].label}</span>
            <div class="status-dot ${statusClass}"></div>
          </div>
        </div>

        <!-- Nome editável -->
        <div class="mb-3">
          <label class="text-[10px] text-gray-600 uppercase tracking-wider block mb-1">Nome da Instância</label>
          <div class="flex gap-2">
            <input id="rename-${id}" type="text" value="${escapeHtml(displayName)}"
              class="flex-1 bg-surface-800 border border-white/5 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-accent-500/50" />
            <button onclick="renameSession('${id}')"
              class="bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white px-3 py-1.5 rounded-lg text-xs transition-colors" title="Salvar nome">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </button>
          </div>
        </div>

        <!-- Telefone -->
        <div class="mb-1">
          <span class="text-[10px] text-gray-600 uppercase tracking-wider">Telefone</span>
          <p class="text-sm ${s.phone ? 'text-white font-mono' : 'text-gray-600 italic'}">${phoneText}</p>
        </div>

        <!-- WhatsApp Name -->
        ${s.name ? `<div class="mb-1"><span class="text-[10px] text-gray-600 uppercase tracking-wider">WhatsApp</span><p class="text-xs text-gray-400">${escapeHtml(s.name)}</p></div>` : ""}

        <!-- Status -->
        <div class="mb-4">
          <span class="text-[10px] text-gray-600 uppercase tracking-wider">Status</span>
          <p class="text-xs text-gray-300">${s.status || "disconnected"}</p>
        </div>

        <!-- Ações -->
        <div class="flex gap-2">
          ${
            isConnected
              ? `<button onclick="stopSession('${id}')" class="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg text-xs font-medium transition-colors">Desconectar</button>`
              : `<button onclick="startSession('${id}')" class="flex-1 bg-accent-500/10 hover:bg-accent-500/20 text-accent-400 px-4 py-2 rounded-lg text-xs font-medium transition-colors">Conectar</button>`
          }
          <button onclick="removeSession('${id}')" class="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-2 rounded-lg text-xs transition-colors" title="Remover instância">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </div>
    `;
  }
  el.innerHTML = html;
}

function startSession(sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = {};
  sessions[sessionId]._waitingQR = true;
  socket.emit("session:start", { sessionId });
}

function stopSession(sessionId) {
  socket.emit("session:stop", { sessionId });
}

function renameSession(sessionId) {
  const input = document.getElementById(`rename-${sessionId}`);
  const customName = input.value.trim();
  if (!customName) return;
  socket.emit("session:rename", { sessionId, customName });
}

function removeSession(sessionId) {
  const idx = sessionId.split("-")[1];
  const s = sessions[sessionId] || {};
  const displayName = s.customName || s.name || `Instância ${idx}`;
  if (!confirm(`Tem certeza que deseja remover "${displayName}"?\n\nIsso vai desconectar e apagar todos os dados dessa instância.`)) return;
  socket.emit("session:remove", { sessionId });
}

// ─── QR Modal ───────────────────────────
function closeQRModal() {
  document.getElementById("qr-modal").classList.add("hidden");
  qrModalSession = null;
}

// ─── Chat List ──────────────────────────
function renderChatList() {
  const el = document.getElementById("chat-list");
  const search = document.getElementById("chat-search").value.toLowerCase();

  const filtered = chats.filter((c) => {
    const name = (c.pushName || c.jid).toLowerCase();
    return name.includes(search);
  });

  if (filtered.length === 0) {
    el.innerHTML = '<div class="p-6 text-center text-gray-600 text-sm">Nenhuma conversa</div>';
    return;
  }

  let html = "";
  for (const chat of filtered) {
    const name = chat.pushName || chat.jid.split("@")[0];
    const time = formatTime(chat.lastTimestamp);
    const active = chat.jid === currentChatJid ? "active" : "";
    const badge = INSTANCE_COLORS[chat.lastSessionId] || { bg: "inst-badge-1", label: "?" };

    html += `
      <div class="chat-item ${active} px-4 py-3 cursor-pointer border-b border-white/5"
           onclick="openChat('${chat.jid}')">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-surface-800 flex items-center justify-center text-sm font-medium text-gray-400 shrink-0">
            ${name.charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-200 truncate">${escapeHtml(name)}</span>
              <span class="text-[10px] text-gray-600 shrink-0">${time}</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="inst-badge ${badge.bg}">${badge.label}</span>
              <span class="text-xs text-gray-500 truncate">${escapeHtml(chat.lastMessage || "")}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  el.innerHTML = html;
}

document.getElementById("chat-search").addEventListener("input", renderChatList);

// ─── Buscar nome do contato (leads ou chats) ──
function findContactName(jid) {
  // 1. Procurar nos leads salvos pelo número
  const num = jid.split("@")[0];
  const lead = leads.find((l) => l.numero === num);
  if (lead && lead.nome) return lead.nome;
  // 2. Procurar nos chats (pushName)
  const chat = chats.find((c) => c.jid === jid);
  if (chat && chat.pushName) return chat.pushName;
  // 3. Fallback: número
  return num;
}

// ─── Open Chat ──────────────────────────
function openChat(jid) {
  currentChatJid = jid;
  renderChatList(); // mark active

  const name = findContactName(jid);
  const num = jid.split("@")[0];
  const initial = name.charAt(0).toUpperCase();

  document.getElementById("chat-header").innerHTML = `
    <div class="w-8 h-8 rounded-full bg-surface-800 flex items-center justify-center text-sm font-medium text-gray-400">
      ${initial}
    </div>
    <div>
      <p class="text-sm font-medium text-white">${escapeHtml(name)}</p>
      <p class="text-[10px] text-gray-500 font-mono">${num}</p>
    </div>
  `;

  document.getElementById("chat-input-area").classList.remove("hidden");
  document.getElementById("chat-messages").innerHTML = '<div class="text-center text-gray-600 text-sm py-8">Carregando...</div>';

  // Focar no campo de texto
  setTimeout(() => {
    document.getElementById("chat-input")?.focus();
  }, 150);

  socket.emit("chat:history", { jid });
}

// ─── Messages ───────────────────────────
function renderMessages(messages) {
  const el = document.getElementById("chat-messages");
  if (messages.length === 0) {
    const name = currentChatJid ? findContactName(currentChatJid) : "";
    const selId = document.getElementById("send-session-select")?.value;
    const sess = selId ? (sessions[selId] || {}) : {};
    const instName = sess.customName || sess.name || selId || "";
    const badge = selId ? INSTANCE_COLORS[selId] : null;
    const badgeHtml = badge ? `<span class="inst-badge ${badge.bg} text-[10px]">${badge.label}</span>` : "";

    el.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center px-4">
        <div class="w-16 h-16 rounded-full bg-accent-500/10 flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
        </div>
        <p class="text-sm text-gray-300 font-medium mb-1">Nova conversa com ${escapeHtml(name)}</p>
        <p class="text-xs text-gray-600 mb-3">Enviando via ${badgeHtml} <span class="text-gray-500">${escapeHtml(instName)}</span></p>
        <p class="text-xs text-gray-600">Digite sua mensagem abaixo e pressione Enter</p>
      </div>
    `;
    return;
  }
  el.innerHTML = "";
  for (const msg of messages) {
    appendMessage(msg);
  }
  scrollMessagesToBottom();
}

function appendMessage(msg) {
  const el = document.getElementById("chat-messages");
  const div = document.createElement("div");
  const align = msg.fromMe ? "flex justify-end" : "flex justify-start";
  const bubbleClass = msg.fromMe ? "msg-outgoing" : "msg-incoming";
  const badge = INSTANCE_COLORS[msg.sessionId] || { bg: "inst-badge-1", label: "?" };
  const time = formatTime(msg.timestamp);

  let content = "";
  switch (msg.type) {
    case "audio":
      if (msg.mediaUrl) {
        content = `
          <div class="audio-player" data-audio-url="${msg.mediaUrl}">
            <button class="audio-play-btn" onclick="toggleAudio(this)">
              <svg class="w-3.5 h-3.5 text-white play-icon" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              <svg class="w-3.5 h-3.5 text-white pause-icon hidden" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
            </button>
            <input type="range" value="0" min="0" max="100" class="audio-seek" oninput="seekAudio(this)" />
            <span class="text-[10px] text-gray-500 audio-time">0:00</span>
            <audio preload="metadata" src="${msg.mediaUrl}"></audio>
          </div>`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
          <span class="text-sm text-gray-400">[Audio]</span>
        </div>`;
      }
      break;
    case "image":
      if (msg.mediaUrl) {
        content = `<img src="${msg.mediaUrl}" class="max-w-xs rounded-lg cursor-pointer" onclick="openMedia('${msg.mediaUrl}','image')" loading="lazy" />`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          <span class="text-sm text-gray-400">[Imagem]</span>
        </div>`;
      }
      if (msg.body && msg.body !== "[Image]") {
        content += `<p class="text-sm mt-1">${escapeHtml(msg.body)}</p>`;
      }
      break;
    case "video":
      if (msg.mediaUrl) {
        content = `<video src="${msg.mediaUrl}" controls class="max-w-xs rounded-lg" style="max-height:280px;"></video>`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          <span class="text-sm text-gray-400">[Video]</span>
        </div>`;
      }
      if (msg.body && msg.body !== "[Video]") {
        content += `<p class="text-sm mt-1">${escapeHtml(msg.body)}</p>`;
      }
      break;
    case "document":
      content = `<div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        ${msg.mediaUrl
          ? `<a href="${msg.mediaUrl}" target="_blank" download class="text-sm text-accent-400 hover:underline">${escapeHtml(msg.body)}</a>`
          : `<span class="text-sm">${escapeHtml(msg.body)}</span>`
        }
      </div>`;
      break;
    default:
      content = `<p class="text-sm">${escapeHtml(msg.body)}</p>`;
  }

  div.className = align;
  div.innerHTML = `
    <div class="msg-bubble ${bubbleClass} px-3.5 py-2.5">
      ${!msg.fromMe ? `<div class="flex items-center gap-2 mb-1"><span class="text-xs font-medium text-gray-300">${escapeHtml(msg.pushName || "")}</span><span class="inst-badge ${badge.bg}">${badge.label}</span></div>` : ""}
      ${content}
      <div class="flex items-center justify-end gap-2 mt-1">
        ${msg.fromMe ? `<span class="inst-badge ${badge.bg}">${badge.label}</span>` : ""}
        <span class="text-[10px] text-gray-500">${time}</span>
      </div>
    </div>
  `;
  el.appendChild(div);
}

function scrollMessagesToBottom() {
  const el = document.getElementById("chat-messages");
  el.scrollTop = el.scrollHeight;
}

// ─── Send Message ───────────────────────
function sendMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text || !currentChatJid) return;

  const sessionId = document.getElementById("send-session-select").value;
  if (!sessionId) {
    alert("Selecione uma instância conectada");
    return;
  }

  const sess = sessions[sessionId];
  if (!sess || sess.status !== "open") {
    alert("A instância selecionada não está conectada. Escolha outra no dropdown.");
    return;
  }

  // Limpar mensagem de boas-vindas se existir
  const msgsEl = document.getElementById("chat-messages");
  if (msgsEl && msgsEl.querySelector(".flex.flex-col.items-center")) {
    msgsEl.innerHTML = "";
  }

  socket.emit("message:send", { sessionId, jid: currentChatJid, text });

  // Mostrar mensagem localmente
  appendMessage({
    id: Date.now().toString(),
    sessionId,
    chatJid: currentChatJid,
    fromMe: true,
    pushName: "",
    type: "text",
    body: text,
    timestamp: Date.now(),
  });
  scrollMessagesToBottom();
  input.value = "";
}

document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Send File (image/audio/document) ───
function setupFileInputs() {
  ["image", "audio", "document"].forEach((type) => {
    const input = document.getElementById(`file-${type}`);
    if (!input) return;
    input.addEventListener("change", async function () {
      const file = this.files[0];
      if (!file) return;
      await handleFileSend(type, file);
      this.value = "";
    });
  });
}

async function handleFileSend(type, file) {
  if (!currentChatJid) {
    alert("Abra um chat primeiro");
    return;
  }

  const sessionId = document.getElementById("send-session-select").value;
  if (!sessionId) {
    alert("Selecione uma instância conectada");
    return;
  }

  const sess = sessions[sessionId];
  if (!sess || sess.status !== "open") {
    alert("A instância selecionada não está conectada. Escolha outra no dropdown.");
    return;
  }

  // Clear welcome screen if present
  const msgsEl = document.getElementById("chat-messages");
  if (msgsEl && msgsEl.querySelector(".flex.flex-col.items-center")) {
    msgsEl.innerHTML = "";
  }

  // Show upload status
  const uploadStatus = document.getElementById("upload-status");
  const uploadText = document.getElementById("upload-status-text");
  const typeLabels = { image: "imagem", audio: "áudio", document: "documento" };
  if (uploadStatus) {
    uploadText.textContent = `Enviando ${typeLabels[type] || "arquivo"}: ${file.name}...`;
    uploadStatus.classList.remove("hidden");
  }

  const fd = new FormData();
  fd.append("sessionId", sessionId);
  fd.append("jid", currentChatJid);
  fd.append("file", file);
  if (type === "image") fd.append("caption", "");

  try {
    const endpoint = `/api/send/${type}`;
    const res = await fetch(endpoint, { method: "POST", body: fd });
    const data = await res.json();

    if (data.success) {
      const msgBody = type === "image" ? (file.name || "[Image]")
        : type === "audio" ? "[Audio]"
        : (file.name || "[Document]");

      appendMessage({
        id: Date.now().toString(),
        sessionId,
        chatJid: currentChatJid,
        fromMe: true,
        pushName: "",
        type,
        body: msgBody,
        mediaUrl: data.mediaUrl || null,
        timestamp: Date.now(),
      });
      scrollMessagesToBottom();
    } else {
      alert("Erro ao enviar: " + (typeof data.message === "string" ? data.message : "Falha no envio"));
    }
  } catch (err) {
    alert("Erro ao enviar arquivo: " + err.message);
  }

  // Hide upload status
  if (uploadStatus) uploadStatus.classList.add("hidden");
}

// ─── Session Dropdowns ──────────────────
function populateSessionDropdowns() {
  const selects = document.querySelectorAll("#send-session-select, .session-dropdown");
  selects.forEach((sel) => {
    // Se há uma instância pré-selecionada via picker, preservar
    const current = pendingSessionForChat || sel.value;
    sel.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const id = `session-${i}`;
      const s = sessions[id] || {};
      const connected = s.status === "open";
      const opt = document.createElement("option");
      opt.value = id;
      const label = s.customName || s.name || `Instância ${i}`;
      opt.textContent = `S${i} — ${label}${connected ? "" : " (offline)"}`;
      opt.disabled = !connected;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    // auto-select first connected
    if (!sel.value || sel.querySelector(`option[value="${sel.value}"]`)?.disabled) {
      const first = sel.querySelector("option:not([disabled])");
      if (first) sel.value = first.value;
    }
  });
}

// ─── Contato Manual ─────────────────────
async function addManualContact() {
  const nameInput = document.getElementById("contact-name");
  const numInput = document.getElementById("contact-number");
  const status = document.getElementById("contact-status");
  const nome = nameInput.value.trim();
  const numero = numInput.value.trim();

  if (!nome || !numero) {
    status.textContent = "Preencha nome e número";
    status.className = "text-xs text-red-400";
    return;
  }

  try {
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, numero }),
    });
    const data = await res.json();
    if (data.success) {
      leads.push(data.contact);
      renderLeads();
      renderContactsView();
      updatePendingBadge();
      nameInput.value = "";
      numInput.value = "";
      status.textContent = "Contato adicionado!";
      status.className = "text-xs text-green-400";
      setTimeout(() => { status.textContent = ""; }, 3000);
    } else {
      status.textContent = data.message || "Erro";
      status.className = "text-xs text-red-400";
    }
  } catch (err) {
    status.textContent = "Erro: " + err.message;
    status.className = "text-xs text-red-400";
  }
}

async function removeContact(numero) {
  try {
    await fetch(`/api/contacts/${numero}`, { method: "DELETE" });
    leads = leads.filter((l) => l.numero !== numero);
    renderLeads();
    renderContactsView();
    updatePendingBadge();
  } catch (_) {}
}

async function loadSavedContacts() {
  try {
    const res = await fetch("/api/contacts");
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      // Merge sem duplicar
      for (const c of data) {
        if (!leads.find((l) => l.numero === c.numero)) {
          leads.push(c);
        }
      }
      renderLeads();
      renderContactsView();
      updatePendingBadge();
    }
  } catch (_) {}
}

// ─── CRM ────────────────────────────────
async function uploadCSV() {
  const fileInput = document.getElementById("csv-file");
  const file = fileInput.files[0];
  if (!file) return;

  const status = document.getElementById("csv-status");
  status.textContent = "Enviando...";

  const fd = new FormData();
  fd.append("csv", file);

  try {
    const res = await fetch("/api/crm/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (data.success) {
      // Mesclar com existentes, marcar novos como não contatados
      for (const l of data.leads) {
        if (!leads.find((x) => x.numero === l.numero)) {
          leads.push({ ...l, contacted: false, contactedAt: null, contactedVia: null });
        }
      }
      status.textContent = `${data.count} leads importados`;
      renderLeads();
      renderContactsView();
      updatePendingBadge();
    } else {
      status.textContent = "Erro: " + (data.error || "Falha");
    }
  } catch (err) {
    status.textContent = "Erro: " + err.message;
  }
}

function renderLeads() {
  const tbody = document.getElementById("leads-tbody");
  const empty = document.getElementById("leads-empty");
  const search = document.getElementById("lead-search").value.toLowerCase();

  const filtered = leads.filter(
    (l) => l.nome.toLowerCase().includes(search) || l.numero.includes(search)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  tbody.innerHTML = filtered
    .map(
      (l) => `
    <tr class="hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 text-gray-300">${escapeHtml(l.nome)}</td>
      <td class="px-4 py-3 font-mono text-gray-400 text-xs">${escapeHtml(l.numero)}</td>
      <td class="px-4 py-3 text-right">
        <div class="inline-flex items-center gap-2">
          <select class="session-dropdown bg-surface-800 border border-white/5 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none">
          </select>
          <button onclick="startConversation('${l.numero}', this.previousElementSibling.value)"
            class="bg-accent-500/10 hover:bg-accent-500/20 text-accent-400 px-3 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap">
            Iniciar Conversa
          </button>
          <button onclick="removeContact('${l.numero}')"
            class="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-2 py-1 rounded text-xs transition-colors" title="Remover">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  // Preencher dropdowns
  populateSessionDropdowns();
}

function filterLeads() {
  renderLeads();
}

let pendingSessionForChat = null; // instância pré-selecionada para próximo chat

async function startConversation(numero, sessionId) {
  if (!sessionId) {
    alert("Selecione uma instância conectada");
    return;
  }
  const clean = numero.replace(/\D/g, "");

  // Marcar como contatado no backend
  try {
    await fetch(`/api/contacts/${clean}/mark-contacted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    // Atualizar local
    const contact = leads.find((l) => l.numero === clean);
    if (contact) {
      contact.contacted = true;
      contact.contactedAt = Date.now();
      contact.contactedVia = sessionId;
    }
    updatePendingBadge();
    renderContactsView();
  } catch (_) {}

  const jid = clean + "@s.whatsapp.net";
  currentChatJid = jid;
  pendingSessionForChat = sessionId;

  switchView("inbox");
  openChat(jid);

  // Setar dropdown DEPOIS do render completo
  setTimeout(() => {
    const sendSelect = document.getElementById("send-session-select");
    if (sendSelect) {
      sendSelect.value = sessionId;
    }
    // Re-renderizar a mensagem de boas-vindas com a instância correta
    const msgs = document.getElementById("chat-messages");
    if (msgs && msgs.querySelector(".flex.flex-col.items-center")) {
      // Chat vazio — re-renderizar para mostrar a instância correta
      renderMessages([]);
    }
    pendingSessionForChat = null;
  }, 200);
}

// ─── Contatos View ──────────────────────
function setContactTab(tab) {
  contactTab = tab;
  document.getElementById("tab-pending").className =
    "contact-tab px-4 py-2 rounded-md text-xs font-medium transition-colors " +
    (tab === "pending" ? "active-tab bg-accent-500/15 text-accent-400" : "text-gray-500 hover:text-gray-300");
  document.getElementById("tab-contacted").className =
    "contact-tab px-4 py-2 rounded-md text-xs font-medium transition-colors " +
    (tab === "contacted" ? "active-tab bg-accent-500/15 text-accent-400" : "text-gray-500 hover:text-gray-300");
  renderContactsView();
}

function renderContactsView() {
  const listEl = document.getElementById("contacts-list");
  const emptyEl = document.getElementById("contacts-empty");
  const emptyText = document.getElementById("contacts-empty-text");
  if (!listEl) return;

  const search = (document.getElementById("contacts-search")?.value || "").toLowerCase();
  const pending = leads.filter((c) => !c.contacted);
  const contacted = leads.filter((c) => c.contacted);

  // Atualizar contadores nas tabs
  const tabPendingCount = document.getElementById("tab-pending-count");
  const tabContactedCount = document.getElementById("tab-contacted-count");
  if (tabPendingCount) tabPendingCount.textContent = pending.length;
  if (tabContactedCount) tabContactedCount.textContent = contacted.length;

  const source = contactTab === "pending" ? pending : contacted;
  const filtered = source.filter(
    (c) => c.nome.toLowerCase().includes(search) || c.numero.includes(search)
  );

  if (filtered.length === 0) {
    listEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    emptyText.textContent = contactTab === "pending"
      ? "Nenhum contato aguardando"
      : "Nenhum contato contatado ainda";
    return;
  }

  emptyEl.classList.add("hidden");

  listEl.innerHTML = filtered.map((c) => {
    const initials = c.nome ? c.nome.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : c.numero.slice(-2);
    const safeNome = (c.nome || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    if (contactTab === "pending") {
      return `
        <div class="contact-card bg-surface-900 border border-white/5 rounded-xl p-4"
             onclick="openInstancePicker('${safeNome}', '${c.numero}')">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-accent-500/15 flex items-center justify-center text-accent-400 text-sm font-semibold shrink-0">
              ${initials}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-white truncate">${escapeHtml(c.nome || "Sem nome")}</p>
              <p class="text-xs text-gray-500 font-mono">${escapeHtml(c.numero)}</p>
            </div>
            <div class="flex items-center gap-1 text-accent-400">
              <span class="text-[10px] font-medium">Iniciar</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </div>
          </div>
        </div>
      `;
    } else {
      const viaColors = INSTANCE_COLORS[c.contactedVia] || { bg: "inst-badge-1", label: "?" };
      return `
        <div class="contact-card bg-surface-900 border border-white/5 rounded-xl p-4"
             onclick="openChatFromContact('${c.numero}')">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center text-green-400 text-sm font-semibold shrink-0">
              ${initials}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-white truncate">${escapeHtml(c.nome || "Sem nome")}</p>
              <p class="text-xs text-gray-500 font-mono">${escapeHtml(c.numero)}</p>
              ${c.contactedVia ? `<div class="flex items-center gap-1.5 mt-1.5">
                <span class="inst-badge ${viaColors.bg}">${viaColors.label}</span>
                <span class="text-[10px] text-gray-600">${c.contactedAt ? formatTime(c.contactedAt) : ""}</span>
              </div>` : ""}
            </div>
            <div class="flex items-center gap-1 text-green-400">
              <span class="text-[10px] font-medium">Conversar</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
            </div>
          </div>
        </div>
      `;
    }
  }).join("");
}

function openChatFromContact(numero) {
  const clean = numero.replace(/\D/g, "");
  const jid = clean + "@s.whatsapp.net";

  // Buscar instância usada anteriormente
  const contact = leads.find((l) => l.numero === clean);
  if (contact && contact.contactedVia) {
    pendingSessionForChat = contact.contactedVia;
  }

  currentChatJid = jid;
  switchView("inbox");
  openChat(jid);

  // Setar dropdown com a instância correta
  if (pendingSessionForChat) {
    setTimeout(() => {
      const sendSelect = document.getElementById("send-session-select");
      if (sendSelect) sendSelect.value = pendingSessionForChat;
      pendingSessionForChat = null;
    }, 200);
  }
}

function updatePendingBadge() {
  const pending = leads.filter((c) => !c.contacted);
  const badge = document.getElementById("pending-count-badge");
  if (badge) {
    if (pending.length > 0) {
      badge.textContent = pending.length;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// ─── Instance Picker Modal ──────────────
function openInstancePicker(nome, numero) {
  pickerContact = { nome, numero };
  const modal = document.getElementById("instance-picker-modal");
  const info = document.getElementById("picker-contact-info");
  const list = document.getElementById("picker-instances");
  const noneMsg = document.getElementById("picker-none-online");

  info.textContent = `${nome} — ${numero}`;

  // Montar lista de instâncias conectadas
  let html = "";
  let hasOnline = false;
  for (let i = 1; i <= 5; i++) {
    const id = `session-${i}`;
    const s = sessions[id] || {};
    const connected = s.status === "open";
    if (!connected) continue;
    hasOnline = true;

    const displayName = s.customName || s.name || `Instância ${i}`;
    const phone = s.phone || "";
    const colors = INSTANCE_COLORS[id];

    html += `
      <button onclick="pickInstanceAndStart('${id}')"
        class="picker-btn w-full flex items-center gap-4 p-4 rounded-xl border border-white/5 hover:border-accent-500/30 hover:bg-accent-500/5 transition-all text-left">
        <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${colors.bg.replace('inst-badge-', 'bg-inst-')}" style="background: ${getInstColor(i)}15;">
          <span class="text-sm font-bold" style="color: ${getInstColor(i)};">${colors.label}</span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-white">${escapeHtml(displayName)}</p>
          <p class="text-xs text-gray-500 font-mono">${phone}</p>
        </div>
        <div class="status-dot status-open shrink-0"></div>
      </button>
    `;
  }

  if (hasOnline) {
    list.innerHTML = html;
    list.classList.remove("hidden");
    noneMsg.classList.add("hidden");
  } else {
    list.innerHTML = "";
    list.classList.add("hidden");
    noneMsg.classList.remove("hidden");
  }

  modal.classList.remove("hidden");
}

function getInstColor(i) {
  const colors = ["#22d3ee", "#a78bfa", "#34d399", "#fb923c", "#f472b6"];
  return colors[(i - 1) % colors.length];
}

function pickInstanceAndStart(sessionId) {
  const contact = pickerContact; // salvar ANTES de fechar
  closeInstancePicker();
  if (contact) {
    startConversation(contact.numero, sessionId);
  }
}

function closeInstancePicker() {
  document.getElementById("instance-picker-modal").classList.add("hidden");
  pickerContact = null;
}

// ─── Audio Player ───────────────────────
function toggleAudio(btn) {
  const player = btn.closest(".audio-player");
  const audio = player.querySelector("audio");
  const playIcon = btn.querySelector(".play-icon");
  const pauseIcon = btn.querySelector(".pause-icon");
  const seek = player.querySelector(".audio-seek");
  const timeEl = player.querySelector(".audio-time");

  if (audio.paused) {
    // Pausar todos os outros áudios
    document.querySelectorAll(".audio-player audio").forEach((a) => {
      if (a !== audio && !a.paused) {
        a.pause();
        const otherPlayer = a.closest(".audio-player");
        otherPlayer.querySelector(".play-icon").classList.remove("hidden");
        otherPlayer.querySelector(".pause-icon").classList.add("hidden");
      }
    });
    audio.play();
    playIcon.classList.add("hidden");
    pauseIcon.classList.remove("hidden");

    audio.ontimeupdate = () => {
      if (audio.duration) {
        seek.value = (audio.currentTime / audio.duration) * 100;
        const m = Math.floor(audio.currentTime / 60);
        const s = Math.floor(audio.currentTime % 60).toString().padStart(2, "0");
        timeEl.textContent = `${m}:${s}`;
      }
    };
    audio.onended = () => {
      playIcon.classList.remove("hidden");
      pauseIcon.classList.add("hidden");
      seek.value = 0;
      timeEl.textContent = "0:00";
    };
  } else {
    audio.pause();
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
  }
}

function seekAudio(rangeEl) {
  const player = rangeEl.closest(".audio-player");
  const audio = player.querySelector("audio");
  if (audio.duration) {
    audio.currentTime = (rangeEl.value / 100) * audio.duration;
  }
}

// ─── Media Modal ────────────────────────
function openMedia(url, type) {
  const modal = document.getElementById("media-modal");
  const img = document.getElementById("media-image");
  const pdf = document.getElementById("media-pdf");
  img.classList.add("hidden");
  pdf.classList.add("hidden");

  if (type === "image") {
    img.src = url;
    img.classList.remove("hidden");
  } else if (type === "pdf") {
    pdf.src = url;
    pdf.classList.remove("hidden");
  }
  modal.classList.remove("hidden");
}

function closeMediaModal() {
  document.getElementById("media-modal").classList.add("hidden");
}

// ─── Utils ──────────────────────────────
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ─── Init ───────────────────────────────
switchView("inbox");
loadSavedContacts();
setupFileInputs();
