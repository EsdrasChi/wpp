// ═══════════════════════════════════════════
//  WPP OUTBOUND — Frontend Application
//  WhatsApp Web Light Mode Clone
// ═══════════════════════════════════════════

const socket = io();
let currentView = "inbox";
let currentChatJid = null;
let chats = [];
let leads = [];
let sessions = {};
let qrModalSession = null;
let contactTab = "pending"; // "pending" ou "contacted"
let pickerContact = null;
let kanbanData = {};
let selectedKanbanCard = null;
let chatFilter = "all"; // "all" | "unread" | "favorites" | "group"
let groupNames = {}; // cache: groupJid -> groupName
let groupInfoCache = {}; // cache: groupJid -> { announce, isAdmin, participants, ... }
let disconnectedSessions = new Set();
let lastRenderedDate = null;

function isSessionDisconnected(sessionId) {
  if (!sessionId) return false;
  const s = sessions[sessionId];
  // Sessao desconectada: nao existe, status disconnected/error, ou sem status
  return !s || !s.status || s.status === "disconnected" || s.status === "error";
}

// Detecta se é um JID LID (identificador interno do WhatsApp, NÃO é telefone)
function isLidJid(jid) {
  return jid && String(jid).endsWith("@lid");
}

// Limpa numero de telefone removendo sufixo de dispositivo (:XX)
// Para LIDs não-resolvidos, retorna string vazia (não é telefone)
function cleanNumber(jidOrNum) {
  if (!jidOrNum) return "";
  const str = String(jidOrNum);
  // LID não é número de telefone
  if (str.endsWith("@lid")) return "";
  const raw = str.split("@")[0];
  return raw.split(":")[0];
}

// Para um JID @lid, tenta encontrar o numero real buscando um chat @s.whatsapp.net com mesmo pushName
function resolveNumberForLid(lidJid) {
  if (!isLidJid(lidJid)) return cleanNumber(lidJid);
  const lidChat = chats.find(c => c.jid === lidJid);
  if (!lidChat || !lidChat.pushName) return "";
  const match = chats.find(c =>
    c.jid !== lidJid &&
    !isLidJid(c.jid) &&
    !c.jid.endsWith("@g.us") &&
    c.pushName === lidChat.pushName
  );
  return match ? cleanNumber(match.jid) : "";
}

const KANBAN_STAGES = [
  { key: 'novo', label: 'Novo', color: '#94a3b8', badge: 'stage-novo' },
  { key: 'tentativa_de_contato', label: 'Tentativa de contato', color: '#fbbf24', badge: 'stage-tentativa' },
  { key: 'conectado', label: 'Conectado', color: '#22c55e', badge: 'stage-conectado' },
  { key: 'conectado_com_secretario', label: 'Conectado c/ secretario', color: '#f97316', badge: 'stage-secretario' },
  { key: 'consultoria_agendada', label: 'Consultoria agendada', color: '#3b82f6', badge: 'stage-agendada' },
  { key: 'consultoria_realizada', label: 'Consultoria realizada', color: '#8b5cf6', badge: 'stage-realizada' },
  { key: 'no_show', label: 'No show', color: '#ef4444', badge: 'stage-noshow' },
  { key: 'perdido', label: 'Perdido', color: '#6b7280', badge: 'stage-perdido' },
];

const INSTANCE_COLORS = {
  "session-1": { bg: "inst-badge-1", label: "S1" },
  "session-2": { bg: "inst-badge-2", label: "S2" },
  "session-3": { bg: "inst-badge-3", label: "S3" },
  "session-4": { bg: "inst-badge-4", label: "S4" },
  "session-5": { bg: "inst-badge-5", label: "S5" },
};

const INST_COLORS_HEX = {
  "session-1": "#00a884",
  "session-2": "#7c3aed",
  "session-3": "#059669",
  "session-4": "#ea580c",
  "session-5": "#db2777",
};

// ─── Navigation ──────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`[data-nav="${view}"]`)?.classList.add("active");

  // Hide all admin views
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));

  if (view === "inbox") {
    // Show left panel and chat area
    document.getElementById("left-panel").classList.remove("hidden");
    document.getElementById("no-chat-selected").classList.toggle("hidden", !!currentChatJid);
    document.getElementById("active-chat").classList.toggle("hidden", !currentChatJid);
    // Garantir que input esteja visível quando chat ativo existe
    if (currentChatJid) {
      document.getElementById("chat-input-area").classList.remove("hidden");
    }
  } else {
    // Show left panel + admin view in right panel, hide chat
    document.getElementById("left-panel").classList.remove("hidden");
    document.getElementById("no-chat-selected").classList.add("hidden");
    document.getElementById("active-chat").classList.add("hidden");
    document.getElementById(`view-${view}`).classList.remove("hidden");

    if (view === "instances") renderInstances();
    if (view === "contacts") renderContactsView();
    if (view === "kanban") loadKanbanData();
  }
}

// ─── Socket Events ───────────────────────
socket.on("sessions:all", (data) => {
  sessions = data;
  renderSidebarInstances();
  renderInstances();
  populateSessionDropdowns();
  renderChatList(); // Re-filtrar chats baseado nos status das sessoes
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

  // Quando status muda, re-filtrar chat list (ocultar/mostrar chats de sessoes offline)
  renderChatList();

  if (data.status === "open" && qrModalSession === data.sessionId) {
    closeQRModal();
  }
});

socket.on("qr:update", (data) => {
  if (qrModalSession === data.sessionId) {
    document.getElementById("qr-image").src = data.qr;
  }
  if (sessions[data.sessionId]?._waitingQR) {
    qrModalSession = data.sessionId;
    const idx = data.sessionId.split("-")[1];
    document.getElementById("qr-modal-title").textContent = `Instancia ${idx} — Escanear QR`;
    document.getElementById("qr-image").src = data.qr;
    document.getElementById("qr-modal").classList.remove("hidden");
    sessions[data.sessionId]._waitingQR = false;
  }
});

socket.on("chats:list", (data) => {
  chats = data; // Manter todos os chats; filtragem visual em renderChatList()
  for (const chat of chats) {
    if (chat.isGroup && chat.groupName) {
      groupNames[chat.jid] = chat.groupName;
    }
  }
  renderChatList();
});

socket.on("message:new", (data) => {
  updateChatListLocally(data.message, data.groupName);
  // Exibir no chat ativo apenas se sessao conectada
  if (data.message.chatJid === currentChatJid && !data.message.fromMe) {
    if (!isSessionDisconnected(data.message.sessionId)) {
      appendMessage(data.message);
      scrollMessagesToBottom();
    }
  }
});

socket.on("chat:messages", (data) => {
  if (data.jid === currentChatJid) {
    // Filtrar mensagens de sessoes desconectadas
    const filtered = data.messages.filter(m => !isSessionDisconnected(m.sessionId));
    renderMessages(filtered);
    // Garantir que input permanece visível após renderização
    document.getElementById("chat-input-area")?.classList.remove("hidden");
    document.getElementById("active-chat")?.classList.remove("hidden");
  }
});

socket.on("message:sent", (data) => {
  if (data.success) {
    document.getElementById("chat-input").value = "";
  }
});

socket.on("chat:cleared", (data) => {
  chats = chats.filter(c => c.jid !== data.jid);
  renderChatList();
  if (currentChatJid === data.jid) {
    currentChatJid = null;
    document.getElementById("active-chat").classList.add("hidden");
    document.getElementById("chat-input-area").classList.add("hidden");
    document.getElementById("no-chat-selected").classList.remove("hidden");
  }
});

socket.on("kanban:stage-changed", (data) => {
  if (currentView === "kanban") loadKanbanData();
  const contact = leads.find(l => l.numero === data.numero);
  if (contact) {
    contact.stage = data.stage;
  }
});

socket.on("group:info", (data) => {
  if (!data || !data.jid) return;
  groupInfoCache[data.jid] = data;
  if (currentChatJid === data.jid) {
    applyGroupInfoToChat(data);
  }
  // Atualizar modal se aberto para este grupo
  const modal = document.getElementById("group-info-modal");
  if (modal && !modal.classList.contains("hidden")) {
    const nameEl = document.getElementById("group-info-name");
    if (nameEl && data.subject && nameEl.textContent !== data.subject) {
      populateGroupInfoModal(data);
    } else if (data.participants && data.participants.length > 0) {
      populateGroupInfoModal(data);
    }
  }
});

socket.on("group:updated", (data) => {
  if (!data || !data.jid) return;
  groupInfoCache[data.jid] = data;
  if (data.subject) groupNames[data.jid] = data.subject;
  if (currentChatJid === data.jid) {
    applyGroupInfoToChat(data);
  }
  renderChatList();
});

// ─── Chat List Local Update ─────────────
function updateChatListLocally(msg, groupName) {
  const jid = msg.chatJid;
  if (!jid) return;

  const isGroup = jid.endsWith("@g.us");
  if (isGroup && groupName) {
    groupNames[jid] = groupName;
  }

  const existing = chats.find((c) => c.jid === jid);
  if (existing) {
    existing.lastMessage = msg.body;
    existing.lastTimestamp = msg.timestamp;
    existing.lastSessionId = msg.sessionId;
    if (msg.pushName) existing.pushName = msg.pushName;
    if (!existing.isGroup) existing.isGroup = isGroup;
    if (isGroup && groupName) existing.groupName = groupName;
  } else {
    chats.push({
      jid,
      lastMessage: msg.body,
      lastTimestamp: msg.timestamp,
      lastSessionId: msg.sessionId,
      pushName: msg.pushName || (isLidJid(jid) ? "" : jid.split("@")[0]),
      sessions: [msg.sessionId],
      isGroup,
      groupName: isGroup ? (groupName || groupNames[jid] || jid.split("@")[0]) : undefined,
    });
  }

  chats.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  renderChatList();
}

function setChatFilter(filter) {
  chatFilter = filter;
  document.querySelectorAll(".chat-filter-btn").forEach((btn) => {
    btn.classList.remove("active-filter", "bg-[#00a884]", "text-white");
    btn.classList.add("bg-[#e9edef]", "text-[#54656f]");
  });
  const activeBtn = document.getElementById(`chat-filter-${filter}`);
  if (activeBtn) {
    activeBtn.classList.add("active-filter", "bg-[#00a884]", "text-white");
    activeBtn.classList.remove("bg-[#e9edef]", "text-[#54656f]");
  }
  renderChatList();
}

// ─── Chat Header Menu ────────────────────
function toggleChatMenu() {
  const menu = document.getElementById("chat-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
}

function closeChatMenu() {
  const menu = document.getElementById("chat-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

function deleteChat(jid) {
  if (!jid) return;
  const name = findContactName(jid);
  if (!confirm(`Apagar todas as mensagens com "${name}"?\n\nEssa acao nao pode ser desfeita.`)) return;
  socket.emit("chat:clear", { jid });
  closeChatMenu();
}

function closeCurrentChat() {
  currentChatJid = null;
  document.getElementById("active-chat").classList.add("hidden");
  document.getElementById("chat-input-area").classList.add("hidden");
  document.getElementById("no-chat-selected").classList.remove("hidden");
  renderChatList();
  closeChatMenu();
}

function toggleAttachMenu() {
  const menu = document.getElementById("attach-menu");
  if (menu) menu.classList.toggle("hidden");
}

// Close menus on outside click
document.addEventListener("click", (e) => {
  const menuWrap = document.getElementById("chat-menu-wrap");
  if (menuWrap && !menuWrap.contains(e.target)) closeChatMenu();
  const attachWrap = document.getElementById("attach-menu-wrap");
  const attachMenu = document.getElementById("attach-menu");
  if (attachWrap && attachMenu && !attachWrap.contains(e.target)) attachMenu.classList.add("hidden");
});

// ─── Toggle Send/Mic based on input ─────
document.getElementById("chat-input").addEventListener("input", (e) => {
  const hasText = e.target.value.trim().length > 0;
  document.getElementById("btn-send").classList.toggle("hidden", !hasText);
  document.getElementById("btn-record").classList.toggle("hidden", hasText);
});

// ─── Sidebar Instances (compact dots) ────
function renderSidebarInstances() {
  const el = document.getElementById("sidebar-instances");
  if (!el) return;

  disconnectedSessions.clear();
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const id = `session-${i}`;
    const s = sessions[id] || { status: "disconnected" };
    const statusClass = `status-${s.status || "disconnected"}`;
    const displayName = s.customName || s.name || `S${i}`;
    const statusLabel = {
      open: "Online",
      connecting: "Conectando",
      qr: "Aguardando QR",
      reconnecting: "Reconectando",
      disconnected: "Offline",
      error: "Erro",
    }[s.status] || "Offline";

    if (s.status === 'disconnected' || s.status === 'error' || !s.status) {
      disconnectedSessions.add(id);
    }

    html += `
      <div class="flex items-center gap-1.5 cursor-default group" title="${escapeHtml(displayName)}: ${statusLabel}">
        <div class="status-dot ${statusClass}" style="width:10px;height:10px;"></div>
        <span class="inst-badge ${INSTANCE_COLORS[id].bg}" style="font-size:8px;">${INSTANCE_COLORS[id].label}</span>
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

    const displayName = s.customName || `Instancia ${i}`;
    const phoneText = s.phone || "Nenhum telefone conectado";

    html += `
      <div class="bg-white border border-[#e9edef] rounded-xl p-5 hover:border-[#00a884]/30 transition-colors">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <span class="inst-badge ${INSTANCE_COLORS[id].bg} text-xs">${INSTANCE_COLORS[id].label}</span>
            <div class="status-dot ${statusClass}"></div>
          </div>
        </div>
        <div class="mb-3">
          <label class="text-[10px] text-[#8696a0] uppercase tracking-wider block mb-1">Nome da Instancia</label>
          <div class="flex gap-2">
            <input id="rename-${id}" type="text" value="${escapeHtml(displayName)}"
              class="flex-1 bg-[#f0f2f5] border border-[#e9edef] rounded-lg px-3 py-1.5 text-sm text-[#111b21] placeholder-[#667781] focus:outline-none focus:border-[#00a884]/50" />
            <button onclick="renameSession('${id}')"
              class="bg-[#f0f2f5] hover:bg-[#e9edef] text-[#54656f] hover:text-[#111b21] px-3 py-1.5 rounded-lg text-xs transition-colors" title="Salvar nome">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </button>
          </div>
        </div>
        <div class="mb-1">
          <span class="text-[10px] text-[#8696a0] uppercase tracking-wider">Telefone</span>
          <p class="text-sm ${s.phone ? 'text-[#111b21] font-mono' : 'text-[#8696a0] italic'}">${phoneText}</p>
        </div>
        ${s.name ? `<div class="mb-1"><span class="text-[10px] text-[#8696a0] uppercase tracking-wider">WhatsApp</span><p class="text-xs text-[#667781]">${escapeHtml(s.name)}</p></div>` : ""}
        <div class="mb-4">
          <span class="text-[10px] text-[#8696a0] uppercase tracking-wider">Status</span>
          <p class="text-xs text-[#111b21]">${s.status || "disconnected"}</p>
        </div>
        <div class="flex gap-2">
          ${
            isConnected
              ? `<button onclick="stopSession('${id}')" class="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 px-4 py-2 rounded-lg text-xs font-medium transition-colors">Desconectar</button>`
              : `<button onclick="startSession('${id}')" class="flex-1 bg-[#00a884]/10 hover:bg-[#00a884]/20 text-[#00a884] px-4 py-2 rounded-lg text-xs font-medium transition-colors">Conectar</button>`
          }
          <button onclick="removeSession('${id}')" class="bg-red-500/10 hover:bg-red-500/20 text-red-500 px-3 py-2 rounded-lg text-xs transition-colors" title="Remover instancia">
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
  const displayName = s.customName || s.name || `Instancia ${idx}`;
  if (!confirm(`Tem certeza que deseja remover "${displayName}"?\n\nIsso vai desconectar e apagar todos os dados dessa instancia.`)) return;
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

  // Deduplicar: coletar pushNames que já possuem chat @s.whatsapp.net
  const phoneNameSet = new Set();
  for (const c of chats) {
    if (c.jid && !isLidJid(c.jid) && !c.jid.endsWith("@g.us") && c.pushName) {
      phoneNameSet.add(c.pushName);
    }
  }

  const filtered = chats.filter((c) => {
    // Ignorar chats com JID inválido
    if (!c.jid || c.jid === "undefined" || c.jid === "null") return false;
    // Bug 1: ocultar @lid quando já existe @s.whatsapp.net com mesmo pushName
    if (isLidJid(c.jid) && c.pushName && phoneNameSet.has(c.pushName)) return false;
    // Ocultar chats de sessoes desconectadas
    if (c.lastSessionId && isSessionDisconnected(c.lastSessionId)) return false;
    const isGroup = c.isGroup || (c.jid && c.jid.endsWith("@g.us"));
    if (chatFilter === "group" && !isGroup) return false;
    if (chatFilter === "unread") return false; // placeholder - not tracked in backend
    if (chatFilter === "favorites") return false; // placeholder
    let displayName;
    if (isGroup) {
      displayName = c.groupName || groupNames[c.jid] || "Grupo " + (c.jid || "").split("@")[0].slice(-6);
    } else if (isLidJid(c.jid)) {
      displayName = c.pushName || "Contato";
    } else {
      const cNum = cleanNumber(c.jid);
      const cLead = cNum ? leads.find(l => l.numero === cNum) : null;
      displayName = (cLead && cLead.nome) ? cLead.nome : (cNum || "Contato");
    }
    return displayName.toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    const emptyMsg = chatFilter === "group" ? "Nenhum grupo" : "Nenhuma conversa";
    el.innerHTML = `<div class="p-6 text-center text-sm text-[#667781]">${emptyMsg}</div>`;
    return;
  }

  const AVATAR_COLORS = ["#00a884","#53bdeb","#7c3aed","#ea580c","#db2777","#f59e0b","#059669"];
  let html = "";
  for (const chat of filtered) {
    const isGroup = chat.isGroup || (chat.jid && chat.jid.endsWith("@g.us"));
    let name;
    if (isGroup) {
      name = chat.groupName || groupNames[chat.jid] || "Grupo " + chat.jid.split("@")[0].slice(-6);
    } else if (isLidJid(chat.jid)) {
      name = chat.pushName || "Contato";
    } else {
      const cNum = cleanNumber(chat.jid);
      const cLead = cNum ? leads.find(l => l.numero === cNum) : null;
      name = (cLead && cLead.nome) ? cLead.nome : (cNum || "Contato");
    }
    const time = formatTime(chat.lastTimestamp);
    const active = chat.jid === currentChatJid ? "active" : "";
    const badge = INSTANCE_COLORS[chat.lastSessionId] || { bg: "inst-badge-1", label: "?" };
    const colorIdx = Math.abs(chat.jid.split("").reduce((a,c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;
    const avatarColor = AVATAR_COLORS[colorIdx];

    const offlineClass = "";

    const avatarContent = isGroup
      ? `<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`
      : `<span class="text-base font-semibold text-white">${name.charAt(0).toUpperCase()}</span>`;

    const previewHtml = escapeHtml(chat.lastMessage || "");

    html += `
      <div class="chat-item ${active} ${offlineClass} px-3 py-[10px] cursor-pointer" data-jid="${chat.jid}"
           style="border-bottom:1px solid #e9edef;">
        <div class="flex items-center gap-3">
          <div class="w-[49px] h-[49px] rounded-full flex items-center justify-center shrink-0" style="background:${avatarColor};">
            ${avatarContent}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-0.5">
              <span class="text-[17px] font-normal truncate text-[#111b21]">${escapeHtml(name)}</span>
              <span class="text-[12px] shrink-0 text-[#667781]">${time}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="inst-badge ${badge.bg}" style="font-size:8px; padding:0 4px;">${badge.label}</span>
              <span class="text-[14px] truncate text-[#667781]">${previewHtml}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  el.innerHTML = html;
}

document.getElementById("chat-search").addEventListener("input", renderChatList);

// ─── Event delegation: chat list clicks (robusto contra DOM replacement) ──
document.getElementById("chat-list").addEventListener("click", (e) => {
  const item = e.target.closest(".chat-item[data-jid]");
  if (item) {
    const jid = item.getAttribute("data-jid");
    if (jid) openChat(jid);
  }
});

// ─── Contact name lookup ──────────────────
function findContactName(jid) {
  if (jid && jid.endsWith("@g.us")) {
    // Grupos: nome real do WhatsApp (metadata)
    if (groupNames[jid]) return groupNames[jid];
    const chat = chats.find((c) => c.jid === jid);
    if (chat && chat.groupName) return chat.groupName;
    return "Grupo " + jid.split("@")[0].slice(-6);
  }
  // LID não resolvido — usar pushName do chat se disponível
  if (isLidJid(jid)) {
    const chat = chats.find((c) => c.jid === jid);
    if (chat && chat.pushName) return chat.pushName;
    return "Contato";
  }
  // Contatos individuais: numero limpo (sem sufixo de dispositivo)
  const num = cleanNumber(jid);
  if (!num) return "Contato";
  const lead = leads.find((l) => l.numero === num);
  if (lead && lead.nome) return lead.nome;
  return num;
}

// ─── Open Chat ──────────────────────────
function openChat(jid) {
  if (!jid || jid === "undefined" || jid === "null") return;

  // SEMPRE mostrar area de chat primeiro (antes de qualquer operacao que possa falhar)
  const noChatEl = document.getElementById("no-chat-selected");
  const activeChatEl = document.getElementById("active-chat");
  const inputAreaEl = document.getElementById("chat-input-area");
  const messagesEl = document.getElementById("chat-messages");

  if (noChatEl) noChatEl.classList.add("hidden");
  if (activeChatEl) activeChatEl.classList.remove("hidden");
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  if (inputAreaEl) inputAreaEl.classList.remove("hidden");
  if (messagesEl) messagesEl.innerHTML = '<div class="text-center text-[#667781] text-sm py-8">Carregando...</div>';

  const previousJid = currentChatJid;
  currentChatJid = jid;

  try {
    // Optimized active state toggle
    if (previousJid) {
      const prevItem = document.querySelector(`.chat-item[data-jid="${CSS.escape(previousJid)}"]`);
      if (prevItem) prevItem.classList.remove("active");
    }
    const newItem = document.querySelector(`.chat-item[data-jid="${CSS.escape(jid)}"]`);
    if (newItem) newItem.classList.add("active");

    const isGroup = jid.endsWith("@g.us");
    const name = findContactName(jid);
    const num = cleanNumber(jid);

    // Remover banner admin-only anterior (ao trocar de chat — funciona para grupo e contato)
    const oldBanner = document.getElementById("admin-only-banner");
    if (oldBanner) oldBanner.remove();

    let avatarHtml, subtitleHtml, stageHtml;

    if (isGroup) {
      avatarHtml = `<div class="w-10 h-10 rounded-full bg-[#00a884]/10 flex items-center justify-center text-[#00a884] cursor-pointer" onclick="openGroupInfoModal('${jid}')">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
      </div>`;
      const cachedInfo = groupInfoCache[jid];
      const memberCount = cachedInfo ? cachedInfo.size : "";
      const memberText = memberCount ? `${memberCount} participantes` : "Grupo";
      subtitleHtml = `<span id="group-subtitle" class="text-[11px] text-[#667781] cursor-pointer hover:underline" onclick="openGroupInfoModal('${jid}')">${memberText}</span>`;
      stageHtml = "";
      // Solicitar info do grupo (non-blocking)
      socket.emit("group:info", { jid });
    } else {
      const AVATAR_COLORS = ["#00a884","#53bdeb","#7c3aed","#ea580c","#db2777","#f59e0b","#059669"];
      const colorIdx = Math.abs(jid.split("").reduce((a,c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;
      const avatarColor = AVATAR_COLORS[colorIdx];
      const initial = (name || "?").charAt(0).toUpperCase();
      avatarHtml = `<div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white" style="background:${avatarColor}">${initial}</div>`;
      // Bug 2: Para LID, resolver numero real via pushName match ou exibir pushName
      let displayNum = num;
      if (!displayNum && isLidJid(jid)) {
        displayNum = resolveNumberForLid(jid);
        if (!displayNum) {
          const lidChat = chats.find(c => c.jid === jid);
          displayNum = (lidChat && lidChat.pushName) ? lidChat.pushName : "";
        }
      }
      subtitleHtml = displayNum
        ? `<span class="text-[11px] text-[#667781] font-mono">${escapeHtml(displayNum)}</span>`
        : `<span class="text-[11px] text-[#667781]">Contato</span>`;
      const contact = (num || displayNum) ? leads.find(l => l.numero === (num || displayNum)) : null;
      const currentStage = contact ? (contact.stage || 'novo') : 'novo';
      stageHtml = `
        <select onchange="updateChatStage('${num}', this.value)"
          class="bg-[#f0f2f5] border border-[#e9edef] rounded-lg px-2 py-1 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]/50 ml-auto">
          ${KANBAN_STAGES.map(s => `<option value="${s.key}" ${currentStage === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>`;
    }

    document.getElementById("chat-header").innerHTML = `
      ${avatarHtml}
      <div class="flex-1 min-w-0">
        <p class="text-[15px] font-medium text-[#111b21] truncate">${escapeHtml(name)}</p>
        <p>${subtitleHtml}</p>
      </div>
      ${stageHtml}
      <div class="relative ml-2" id="chat-menu-wrap">
        <button onclick="toggleChatMenu()" class="wpp-icon-btn" title="Menu">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <div id="chat-dropdown-menu" class="chat-header-menu hidden">
          ${isGroup ? `<button onclick="openGroupInfoModal('${jid}'); closeChatMenu();">
            <svg class="w-4 h-4 inline mr-2 opacity-60" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            Info do grupo
          </button>` : `<button onclick="updateChatStage('${num}', document.querySelector('#chat-header select')?.value || 'novo')">
            <svg class="w-4 h-4 inline mr-2 opacity-60" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
            Salvar etapa
          </button>`}
          <button onclick="closeCurrentChat()">
            <svg class="w-4 h-4 inline mr-2 opacity-60" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            Fechar chat
          </button>
          <button class="danger" onclick="deleteChat('${jid}')">
            <svg class="w-4 h-4 inline mr-2 opacity-60" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            Apagar conversa
          </button>
        </div>
      </div>
    `;
  } catch (err) {
    console.error("[openChat] Erro ao renderizar header:", err);
  }

  setTimeout(() => {
    document.getElementById("chat-input")?.focus();
  }, 150);

  socket.emit("chat:history", { jid });
}

// ─── Date Separator ─────────────────────
function maybeInsertDateSeparator(timestamp) {
  const el = document.getElementById("chat-messages");
  const msgDate = new Date(timestamp);
  const dateStr = msgDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  if (dateStr !== lastRenderedDate) {
    lastRenderedDate = dateStr;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label = dateStr;
    if (msgDate.toDateString() === today.toDateString()) label = 'HOJE';
    else if (msgDate.toDateString() === yesterday.toDateString()) label = 'ONTEM';

    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${label}</span>`;
    el.appendChild(sep);
  }
}

// ─── Messages ───────────────────────────
function renderMessages(messages) {
  const el = document.getElementById("chat-messages");
  lastRenderedDate = null;

  if (messages.length === 0) {
    const name = currentChatJid ? findContactName(currentChatJid) : "";
    const selId = document.getElementById("send-session-select")?.value;
    const sess = selId ? (sessions[selId] || {}) : {};
    const instName = sess.customName || sess.name || selId || "";
    const badge = selId ? INSTANCE_COLORS[selId] : null;
    const badgeHtml = badge ? `<span class="inst-badge ${badge.bg} text-[10px]">${badge.label}</span>` : "";

    el.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-center px-4">
        <div class="w-16 h-16 rounded-full bg-[#00a884]/10 flex items-center justify-center mb-4">
          <svg class="w-8 h-8 text-[#00a884]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
        </div>
        <p class="text-sm text-[#111b21] font-medium mb-1">Nova conversa com ${escapeHtml(name)}</p>
        <p class="text-xs text-[#667781] mb-3">Enviando via ${badgeHtml} <span class="text-[#111b21]">${escapeHtml(instName)}</span></p>
        <p class="text-xs text-[#8696a0]">Digite sua mensagem abaixo e pressione Enter</p>
      </div>
    `;
    return;
  }
  el.innerHTML = "";
  for (const msg of messages) {
    maybeInsertDateSeparator(msg.timestamp);
    appendMessage(msg);
  }
  scrollMessagesToBottom();
}

function appendMessage(msg) {
  const el = document.getElementById("chat-messages");

  // Insert date separator for real-time messages
  if (el.children.length > 0 || lastRenderedDate) {
    maybeInsertDateSeparator(msg.timestamp);
  }

  const div = document.createElement("div");
  const align = msg.fromMe ? "flex justify-end" : "flex justify-start";
  const bubbleClass = msg.fromMe ? "msg-outgoing" : "msg-incoming";
  const badge = INSTANCE_COLORS[msg.sessionId] || { bg: "inst-badge-1", label: "?" };
  const time = formatTime(msg.timestamp);
  const isGroup = msg.isGroup || (currentChatJid && currentChatJid.endsWith("@g.us"));

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
            <span class="text-[10px] text-[#667781] audio-time">0:00</span>
            <audio preload="metadata" src="${msg.mediaUrl}"></audio>
          </div>`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-[#8696a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
          <span class="text-sm text-[#8696a0]">[Audio]</span>
        </div>`;
      }
      break;
    case "image":
      if (msg.mediaUrl) {
        content = `<img src="${msg.mediaUrl}" class="max-w-xs rounded-lg cursor-pointer" onclick="openMedia('${msg.mediaUrl}','image')" loading="lazy" />`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-[#8696a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          <span class="text-sm text-[#8696a0]">[Imagem]</span>
        </div>`;
      }
      if (msg.body && msg.body !== "[Image]") {
        content += `<p class="text-[14.2px] text-[#111b21] mt-1">${escapeHtml(msg.body)}</p>`;
      }
      break;
    case "video":
      if (msg.mediaUrl) {
        content = `<video src="${msg.mediaUrl}" controls class="max-w-xs rounded-lg" style="max-height:280px;"></video>`;
      } else {
        content = `<div class="flex items-center gap-2 py-1">
          <svg class="w-5 h-5 text-[#8696a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          <span class="text-sm text-[#8696a0]">[Video]</span>
        </div>`;
      }
      if (msg.body && msg.body !== "[Video]") {
        content += `<p class="text-[14.2px] text-[#111b21] mt-1">${escapeHtml(msg.body)}</p>`;
      }
      break;
    case "document":
      content = `<div class="flex items-center gap-2 bg-[#f0f2f5] rounded-lg p-3">
        <svg class="w-8 h-8 text-[#00a884] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        ${msg.mediaUrl
          ? `<a href="${msg.mediaUrl}" target="_blank" download class="text-sm text-[#00a884] hover:underline truncate">${escapeHtml(msg.body)}</a>`
          : `<span class="text-sm text-[#111b21]">${escapeHtml(msg.body)}</span>`
        }
      </div>`;
      break;
    default:
      content = `<p class="text-[14.2px] text-[#111b21] leading-[19px]">${escapeHtml(msg.body)}</p>`;
  }

  // Sender header in groups
  let senderHeader = "";
  if (isGroup) {
    let senderName;
    if (msg.fromMe) {
      senderName = "Voce";
    } else if (msg.pushName) {
      senderName = msg.pushName;
    } else if (msg.participant && !isLidJid(msg.participant)) {
      senderName = cleanNumber(msg.participant) || "Participante";
    } else {
      senderName = "Participante";
    }
    const senderColor = msg.fromMe ? "#00a884" : "#06cf9c";
    senderHeader = `<div class="mb-0.5"><span class="text-[12.5px] font-medium" style="color:${senderColor};">${escapeHtml(senderName)}</span></div>`;
  }

  // Instance tag (discrete)
  const instTag = `<span class="inst-badge ${badge.bg}" style="font-size:8px; padding:0 3px; margin-right:3px; vertical-align:middle;">${badge.label}</span>`;

  // Double check marks
  const checks = msg.fromMe ? `<span class="msg-checks">&#10003;&#10003;</span>` : "";

  div.className = align + " mb-[2px]";
  div.innerHTML = `
    <div class="msg-bubble ${bubbleClass}">
      ${senderHeader}
      ${content}
      <span class="msg-time">${instTag}${time}${checks}</span>
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
    alert("Selecione uma instancia conectada");
    return;
  }

  const sess = sessions[sessionId];
  if (!sess || sess.status !== "open") {
    alert("A instancia selecionada nao esta conectada. Escolha outra no dropdown.");
    return;
  }

  // Clear welcome screen
  const msgsEl = document.getElementById("chat-messages");
  if (msgsEl && msgsEl.querySelector(".flex.flex-col.items-center")) {
    msgsEl.innerHTML = "";
    lastRenderedDate = null;
  }

  socket.emit("message:send", { sessionId, jid: currentChatJid, text });

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
  document.getElementById("btn-send").classList.add("hidden");
  document.getElementById("btn-record").classList.remove("hidden");
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
    alert("Selecione uma instancia conectada");
    return;
  }

  const sess = sessions[sessionId];
  if (!sess || sess.status !== "open") {
    alert("A instancia selecionada nao esta conectada. Escolha outra no dropdown.");
    return;
  }

  const msgsEl = document.getElementById("chat-messages");
  if (msgsEl && msgsEl.querySelector(".flex.flex-col.items-center")) {
    msgsEl.innerHTML = "";
    lastRenderedDate = null;
  }

  const uploadStatus = document.getElementById("upload-status");
  const uploadText = document.getElementById("upload-status-text");
  const typeLabels = { image: "imagem", audio: "audio", document: "documento" };
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

  if (uploadStatus) uploadStatus.classList.add("hidden");
}

// ─── Session Dropdowns ──────────────────
function populateSessionDropdowns() {
  const selects = document.querySelectorAll("#send-session-select, .session-dropdown");
  selects.forEach((sel) => {
    const current = pendingSessionForChat || sel.value;
    sel.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const id = `session-${i}`;
      const s = sessions[id] || {};
      const connected = s.status === "open";
      const opt = document.createElement("option");
      opt.value = id;
      const label = s.customName || s.name || `Instancia ${i}`;
      opt.textContent = `S${i} — ${label}${connected ? "" : " (offline)"}`;
      opt.disabled = !connected;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
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
    status.textContent = "Preencha nome e numero";
    status.className = "text-xs text-red-500";
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
      status.className = "text-xs text-[#00a884]";
      setTimeout(() => { status.textContent = ""; }, 3000);
    } else {
      status.textContent = data.message || "Erro";
      status.className = "text-xs text-red-500";
    }
  } catch (err) {
    status.textContent = "Erro: " + err.message;
    status.className = "text-xs text-red-500";
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
    <tr class="hover:bg-[#f5f6f6] transition-colors">
      <td class="px-4 py-3 text-[#111b21]">${escapeHtml(l.nome)}</td>
      <td class="px-4 py-3 font-mono text-[#667781] text-xs">${escapeHtml(l.numero)}</td>
      <td class="px-4 py-3 text-right">
        <div class="inline-flex items-center gap-2">
          <select class="session-dropdown bg-[#f0f2f5] border border-[#e9edef] rounded px-2 py-1 text-xs text-[#111b21] focus:outline-none">
          </select>
          <button onclick="startConversation('${l.numero}', this.previousElementSibling.value)"
            class="bg-[#00a884]/10 hover:bg-[#00a884]/20 text-[#00a884] px-3 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap">
            Iniciar Conversa
          </button>
          <button onclick="removeContact('${l.numero}')"
            class="bg-red-500/10 hover:bg-red-500/20 text-red-500 px-2 py-1 rounded text-xs transition-colors" title="Remover">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  populateSessionDropdowns();
}

function filterLeads() {
  renderLeads();
}

let pendingSessionForChat = null;

async function startConversation(numero, sessionId) {
  if (!sessionId) {
    alert("Selecione uma instancia conectada");
    return;
  }
  const clean = numero.replace(/\D/g, "");

  try {
    await fetch(`/api/contacts/${clean}/mark-contacted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const contact = leads.find((l) => l.numero === clean);
    if (contact) {
      contact.contacted = true;
      contact.contactedAt = Date.now();
      contact.contactedVia = sessionId;
      if (contact.stage === 'novo' || !contact.stage) {
        contact.stage = 'tentativa_de_contato';
        contact.stageUpdatedAt = Date.now();
      }
    }
    updatePendingBadge();
    renderContactsView();
  } catch (_) {}

  const jid = clean + "@s.whatsapp.net";
  currentChatJid = jid;
  pendingSessionForChat = sessionId;

  switchView("inbox");
  openChat(jid);

  setTimeout(() => {
    const sendSelect = document.getElementById("send-session-select");
    if (sendSelect) {
      sendSelect.value = sessionId;
    }
    const msgs = document.getElementById("chat-messages");
    if (msgs && msgs.querySelector(".flex.flex-col.items-center")) {
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
    (tab === "pending" ? "active-tab" : "text-[#667781] hover:text-[#111b21]");
  document.getElementById("tab-contacted").className =
    "contact-tab px-4 py-2 rounded-md text-xs font-medium transition-colors " +
    (tab === "contacted" ? "active-tab" : "text-[#667781] hover:text-[#111b21]");
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
        <div class="contact-card rounded-xl p-4"
             onclick="openInstancePicker('${safeNome}', '${c.numero}')">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-[#00a884]/10 flex items-center justify-center text-[#00a884] text-sm font-semibold shrink-0">
              ${initials}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-[#111b21] truncate">${escapeHtml(c.nome || "Sem nome")}</p>
              <p class="text-xs text-[#667781] font-mono">${escapeHtml(c.numero)}</p>
            </div>
            <div class="flex items-center gap-1 text-[#00a884]">
              <span class="text-[10px] font-medium">Iniciar</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </div>
          </div>
        </div>
      `;
    } else {
      const viaColors = INSTANCE_COLORS[c.contactedVia] || { bg: "inst-badge-1", label: "?" };
      return `
        <div class="contact-card rounded-xl p-4"
             onclick="openChatFromContact('${c.numero}')">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-[#00a884]/10 flex items-center justify-center text-[#00a884] text-sm font-semibold shrink-0">
              ${initials}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-[#111b21] truncate">${escapeHtml(c.nome || "Sem nome")}</p>
              <p class="text-xs text-[#667781] font-mono">${escapeHtml(c.numero)}</p>
              ${c.contactedVia ? `<div class="flex items-center gap-1.5 mt-1.5">
                <span class="inst-badge ${viaColors.bg}">${viaColors.label}</span>
                <span class="text-[10px] text-[#8696a0]">${c.contactedAt ? formatTime(c.contactedAt) : ""}</span>
              </div>` : ""}
            </div>
            <div class="flex items-center gap-1 text-[#00a884]">
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

  const contact = leads.find((l) => l.numero === clean);
  if (contact && contact.contactedVia) {
    pendingSessionForChat = contact.contactedVia;
  }

  currentChatJid = jid;
  switchView("inbox");
  openChat(jid);

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

  let html = "";
  let hasOnline = false;
  for (let i = 1; i <= 5; i++) {
    const id = `session-${i}`;
    const s = sessions[id] || {};
    const connected = s.status === "open";
    if (!connected) continue;
    hasOnline = true;

    const displayName = s.customName || s.name || `Instancia ${i}`;
    const phone = s.phone || "";
    const colors = INSTANCE_COLORS[id];
    const hexColor = INST_COLORS_HEX[id];

    html += `
      <button onclick="pickInstanceAndStart('${id}')"
        class="picker-btn w-full flex items-center gap-4 p-4 rounded-xl border border-[#e9edef] hover:border-[#00a884]/30 hover:bg-[#00a884]/5 transition-all text-left">
        <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style="background: ${hexColor}15;">
          <span class="text-sm font-bold" style="color: ${hexColor};">${colors.label}</span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-[#111b21]">${escapeHtml(displayName)}</p>
          <p class="text-xs text-[#667781] font-mono">${phone}</p>
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

function pickInstanceAndStart(sessionId) {
  const contact = pickerContact;
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

// ─── Audio Recording ────────────────────
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimerInterval = null;
let audioContext = null;
let analyserNode = null;
let waveformAnimId = null;
let recordingStream = null;
let recordingCancelled = false;

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  if (!currentChatJid) {
    alert("Abra um chat primeiro");
    return;
  }
  const sessionId = document.getElementById("send-session-select").value;
  if (!sessionId || !sessions[sessionId] || sessions[sessionId].status !== "open") {
    alert("Selecione uma instancia conectada");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStream = stream;
    recordingCancelled = false;
    audioChunks = [];
    // Prefer OGG/Opus (native WhatsApp format), fallback to WebM/Opus
    const preferredTypes = [
      "audio/ogg;codecs=opus",
      "audio/webm;codecs=opus",
      "audio/webm",
    ];
    let chosenMime = "";
    for (const t of preferredTypes) {
      if (MediaRecorder.isTypeSupported(t)) { chosenMime = t; break; }
    }
    mediaRecorder = new MediaRecorder(stream, chosenMime ? { mimeType: chosenMime } : {});

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      cleanupRecordingUI();

      if (recordingCancelled) {
        audioChunks = [];
        return;
      }

      const actualMime = mediaRecorder.mimeType || "audio/webm";
      const ext = actualMime.includes("ogg") ? "ogg" : actualMime.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(audioChunks, { type: actualMime });
      if (blob.size < 1000) return;

      const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: actualMime });
      await handleFileSend("audio", file);
    };

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    source.connect(analyserNode);

    mediaRecorder.start(100);
    recordingStartTime = Date.now();

    document.getElementById("input-normal").classList.add("hidden");
    document.getElementById("input-recording").style.display = "flex";
    document.getElementById("input-recording").classList.remove("hidden");
    document.getElementById("btn-send").classList.add("hidden");

    const btn = document.getElementById("btn-record");
    btn.classList.add("recording-active");
    document.getElementById("mic-icon").classList.add("hidden");
    document.getElementById("stop-icon").classList.remove("hidden");

    const timer = document.getElementById("recording-timer");
    timer.textContent = "0:00";
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = (elapsed % 60).toString().padStart(2, "0");
      timer.textContent = `${m}:${s}`;
    }, 500);

    drawWaveform();

  } catch (err) {
    alert("Nao foi possivel acessar o microfone. Permita o acesso nas configuracoes do navegador.");
    console.error("Mic error:", err);
  }
}

function stopRecording() {
  recordingCancelled = false;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

function cancelRecording() {
  recordingCancelled = true;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
    cleanupRecordingUI();
  }
}

function cleanupRecordingUI() {
  clearInterval(recordingTimerInterval);
  if (waveformAnimId) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyserNode = null;
  }
  recordingStream = null;

  document.getElementById("input-normal").classList.remove("hidden");
  document.getElementById("input-recording").style.display = "";
  document.getElementById("input-recording").classList.add("hidden");
  const hasText = document.getElementById("chat-input").value.trim().length > 0;
  document.getElementById("btn-send").classList.toggle("hidden", !hasText);
  document.getElementById("btn-record").classList.toggle("hidden", hasText);

  const btn = document.getElementById("btn-record");
  btn.classList.remove("recording-active");
  document.getElementById("mic-icon").classList.remove("hidden");
  document.getElementById("stop-icon").classList.add("hidden");
}

function drawWaveform() {
  if (!analyserNode) return;

  const canvas = document.getElementById("waveform-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!analyserNode) return;
    waveformAnimId = requestAnimationFrame(draw);

    analyserNode.getByteFrequencyData(dataArray);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const barCount = 40;
    const gap = 2;
    const barWidth = (w - gap * (barCount - 1)) / barCount;
    const step = Math.floor(bufferLength / barCount);

    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += dataArray[i * step + j];
      }
      const avg = sum / step;
      const barHeight = Math.max(2, (avg / 255) * h * 0.9);
      const x = i * (barWidth + gap);
      const y = (h - barHeight) / 2;

      ctx.fillStyle = `rgba(0, 168, 132, ${0.4 + (avg / 255) * 0.6})`;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  draw();
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

// ─── Kanban Board ───────────────────────
async function loadKanbanData() {
  try {
    const res = await fetch("/api/kanban");
    kanbanData = await res.json();
    renderKanban();
  } catch (err) {
    console.error("Failed to load Kanban:", err);
  }
}

function renderKanban() {
  const board = document.getElementById("kanban-board");
  if (!board) return;

  board.innerHTML = KANBAN_STAGES.map(stage => {
    const contacts = kanbanData[stage.key] || [];
    return `
      <div class="kanban-column">
        <div class="kanban-column-header">
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 rounded-full" style="background: ${stage.color};"></div>
            <h3 class="text-sm font-semibold text-[#111b21]">${stage.label}</h3>
          </div>
          <span class="text-xs font-bold text-[#667781]">${contacts.length}</span>
        </div>
        <div class="kanban-column-body">
          ${contacts.map(c => renderKanbanCard(c, stage)).join('')}
          ${contacts.length === 0 ? '<p class="text-xs text-[#8696a0] text-center py-8">Nenhum lead</p>' : ''}
        </div>
      </div>`;
  }).join('');
}

function renderKanbanCard(c, stage) {
  const initials = c.nome ? c.nome.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : c.numero.slice(-2);
  const viaColors = c.contactedVia ? INSTANCE_COLORS[c.contactedVia] : null;
  const time = c.stageUpdatedAt ? formatTime(c.stageUpdatedAt) : '';
  const safeNumero = c.numero.replace(/'/g, "\\'");

  return `
    <div class="kanban-card" onclick="openKanbanCardModal('${safeNumero}')">
      <div class="flex items-start gap-3 mb-1">
        <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
             style="background: ${stage.color}20; color: ${stage.color};">
          ${initials}
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-[#111b21] truncate">${escapeHtml(c.nome || "Sem nome")}</p>
          <p class="text-[10px] text-[#667781] font-mono">${escapeHtml(c.numero)}</p>
        </div>
      </div>
      ${c.notes ? `<p class="text-[11px] text-[#667781] mt-2 line-clamp-2 leading-relaxed">${escapeHtml(c.notes)}</p>` : ''}
      <div class="flex items-center justify-between mt-2 pt-2 border-t border-[#e9edef]">
        ${viaColors ? `<span class="inst-badge ${viaColors.bg}">${viaColors.label}</span>` : '<span></span>'}
        <span class="text-[10px] text-[#8696a0]">${time}</span>
      </div>
    </div>`;
}

function openKanbanCardModal(numero) {
  const clean = numero.replace(/\D/g, "");
  const allContacts = Object.values(kanbanData).flat();
  const contact = allContacts.find(c => c.numero === clean);
  if (!contact) return;

  selectedKanbanCard = contact;

  document.getElementById("kanban-card-name").textContent = contact.nome || "Sem nome";
  document.getElementById("kanban-card-number").textContent = contact.numero;
  document.getElementById("kanban-card-stage").value = contact.stage || 'novo';
  document.getElementById("kanban-card-notes").value = contact.notes || '';
  document.getElementById("kanban-card-modal").classList.remove("hidden");
}

function closeKanbanCardModal() {
  document.getElementById("kanban-card-modal").classList.add("hidden");
  selectedKanbanCard = null;
}

async function saveKanbanCard() {
  if (!selectedKanbanCard) return;

  const newStage = document.getElementById("kanban-card-stage").value;
  const newNotes = document.getElementById("kanban-card-notes").value.trim();

  try {
    if (newStage !== selectedKanbanCard.stage) {
      await fetch(`/api/contacts/${selectedKanbanCard.numero}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
    }
    if (newNotes !== (selectedKanbanCard.notes || '')) {
      await fetch(`/api/contacts/${selectedKanbanCard.numero}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: newNotes }),
      });
    }
    const local = leads.find(l => l.numero === selectedKanbanCard.numero);
    if (local) {
      local.stage = newStage;
      local.notes = newNotes;
      local.stageUpdatedAt = Date.now();
    }
    closeKanbanCardModal();
    loadKanbanData();
  } catch (err) {
    alert("Erro ao salvar: " + err.message);
  }
}

function openChatFromKanban() {
  if (!selectedKanbanCard) return;

  const clean = selectedKanbanCard.numero.replace(/\D/g, "");
  const jid = clean + "@s.whatsapp.net";

  if (selectedKanbanCard.contactedVia) {
    pendingSessionForChat = selectedKanbanCard.contactedVia;
  }

  closeKanbanCardModal();
  currentChatJid = jid;
  switchView("inbox");
  openChat(jid);

  if (pendingSessionForChat) {
    setTimeout(() => {
      const sendSelect = document.getElementById("send-session-select");
      if (sendSelect) sendSelect.value = pendingSessionForChat;
      pendingSessionForChat = null;
    }, 200);
  }
}

async function updateChatStage(numero, newStage) {
  try {
    let contact = leads.find(l => l.numero === numero);

    if (!contact) {
      const chatName = findContactName(numero + "@s.whatsapp.net");
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: chatName !== numero ? chatName : "", numero }),
      });
      const data = await res.json();
      if (data.success && data.contact) {
        leads.push(data.contact);
        contact = data.contact;
      }
    }

    socket.emit("contact:update-stage", { numero, stage: newStage });

    if (contact) {
      contact.stage = newStage;
      contact.stageUpdatedAt = Date.now();
    }
  } catch (err) {
    console.error("Failed to update stage:", err);
  }
}

// ─── Group Info ─────────────────────────
function applyGroupInfoToChat(info) {
  if (!info || info.jid !== currentChatJid) return;

  // Atualizar subtitle com contagem de participantes
  const subtitleEl = document.getElementById("group-subtitle");
  if (subtitleEl && info.size) {
    subtitleEl.textContent = `${info.size} participantes`;
  }

  // Remover banner admin-only anterior
  const existingBanner = document.getElementById("admin-only-banner");
  if (existingBanner) existingBanner.remove();

  const inputArea = document.getElementById("chat-input-area");

  if (info.announce && !info.isAdmin) {
    // Grupo admin-only e usuario NAO eh admin — esconder input, mostrar banner
    if (inputArea) inputArea.classList.add("hidden");

    const banner = document.createElement("div");
    banner.id = "admin-only-banner";
    banner.className = "flex items-center justify-center gap-2 py-3 px-4 bg-[#fef3c7] border-t border-[#fbbf24]/30";
    banner.innerHTML = `
      <svg class="w-4 h-4 text-[#d97706] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
      </svg>
      <span class="text-sm text-[#92400e]">Somente admins podem enviar mensagens</span>
    `;
    const activeChat = document.getElementById("active-chat");
    if (activeChat) activeChat.appendChild(banner);
  } else {
    // Grupo normal ou usuario eh admin — mostrar input
    if (inputArea) inputArea.classList.remove("hidden");
  }
}

function openGroupInfoModal(groupJid) {
  const info = groupInfoCache[groupJid];
  const modal = document.getElementById("group-info-modal");

  if (!info || !info.participants || info.participants.length === 0) {
    // Mostrar loading e solicitar dados
    const name = groupNames[groupJid] || "Grupo";
    document.getElementById("group-info-name").textContent = name;
    document.getElementById("group-info-meta").textContent = "Carregando...";
    document.getElementById("group-info-count").textContent = "...";
    document.getElementById("group-info-participants").innerHTML =
      '<div class="p-6 text-center text-sm text-[#667781]">Carregando participantes...</div>';
    document.getElementById("group-info-desc-section").classList.add("hidden");
    document.getElementById("group-info-announce-section").classList.add("hidden");
    modal.classList.remove("hidden");
    socket.emit("group:info", { jid: groupJid });
    return;
  }

  populateGroupInfoModal(info);
  modal.classList.remove("hidden");
}

function populateGroupInfoModal(info) {
  const name = info.subject || groupNames[info.jid] || "Grupo";
  document.getElementById("group-info-name").textContent = name;
  document.getElementById("group-info-meta").textContent = `Grupo \u2022 ${info.size || info.participants.length} participantes`;
  document.getElementById("group-info-count").textContent = info.size || info.participants.length;

  const descSection = document.getElementById("group-info-desc-section");
  if (info.desc) {
    document.getElementById("group-info-desc").textContent = info.desc;
    descSection.classList.remove("hidden");
  } else {
    descSection.classList.add("hidden");
  }

  const announceSection = document.getElementById("group-info-announce-section");
  if (info.announce) {
    announceSection.classList.remove("hidden");
  } else {
    announceSection.classList.add("hidden");
  }

  renderGroupParticipants(info.participants);
}

function renderGroupParticipants(participants) {
  const container = document.getElementById("group-info-participants");
  if (!participants || participants.length === 0) {
    container.innerHTML = '<div class="p-6 text-center text-sm text-[#667781]">Nenhum participante</div>';
    return;
  }

  const sorted = [...participants].sort((a, b) => {
    const order = { superadmin: 0, admin: 1 };
    return (order[a.admin] ?? 2) - (order[b.admin] ?? 2);
  });

  const AVATAR_COLORS = ["#00a884","#53bdeb","#7c3aed","#ea580c","#db2777","#f59e0b","#059669"];

  container.innerHTML = sorted.map(p => {
    const displayName = p.pushName || (p.phone ? p.phone : (isLidJid(p.jid) ? "Participante" : cleanNumber(p.jid))) || "Participante";
    const phoneDisplay = p.phone || "";
    const initial = displayName.charAt(0).toUpperCase();
    const colorIdx = Math.abs((p.jid || "").split("").reduce((a,c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;
    const avatarColor = AVATAR_COLORS[colorIdx];

    let roleBadge = "";
    if (p.admin === "superadmin") {
      roleBadge = '<span class="text-[9px] font-semibold px-1.5 py-0.5 rounded" style="background:rgba(0,168,132,0.12);color:#00a884;">Admin</span>';
    } else if (p.admin === "admin") {
      roleBadge = '<span class="text-[9px] font-semibold px-1.5 py-0.5 rounded" style="background:rgba(59,130,246,0.12);color:#3b82f6;">Admin</span>';
    }

    return `
      <div class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#f5f6f6] transition-colors">
        <div class="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0" style="background:${avatarColor}">
          ${initial}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm text-[#111b21] truncate">${escapeHtml(displayName)}</span>
            ${roleBadge}
          </div>
          ${phoneDisplay ? `<span class="text-[11px] text-[#667781] font-mono">${escapeHtml(phoneDisplay)}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function closeGroupInfoModal() {
  document.getElementById("group-info-modal").classList.add("hidden");
}

// ─── Init ───────────────────────────────
switchView("inbox");
loadSavedContacts();
setupFileInputs();
