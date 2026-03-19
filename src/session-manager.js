const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const SESSION_DIR = path.resolve(process.env.SESSION_DIR || "./sessions");
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || "5", 10);

const BROWSER_PROFILES = [
  ["Chrome", "MacOS", "122.0.6261.94"],
  ["Safari", "MacOS", "17.3.1"],
  ["Chrome", "Windows", "122.0.6261.112"],
  ["Edge", "Windows", "122.0.2365.66"],
  ["Chrome", "Linux", "122.0.6261.94"],
];

class SessionManager {
  constructor(io) {
    this.io = io;
    this.sessions = new Map();
    this.retryCount = new Map();
    this.messageStore = new Map(); // sessionId -> Map(chatJid -> messages[])
    this.customNames = new Map(); // sessionId -> user-defined label
    this.contacts = []; // manual contacts list
    this.logger = pino({ level: process.env.LOG_LEVEL || "error" });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    this._loadData();
  }

  // ── Persistir dados locais (nomes + contatos) ──
  _dataFile() { return path.join(SESSION_DIR, "_appdata.json"); }

  _loadData() {
    try {
      const raw = fs.readFileSync(this._dataFile(), "utf-8");
      const data = JSON.parse(raw);
      if (data.customNames) {
        for (const [k, v] of Object.entries(data.customNames)) this.customNames.set(k, v);
      }
      if (data.contacts) this.contacts = data.contacts;
    } catch (_) {}
  }

  _saveData() {
    const data = {
      customNames: Object.fromEntries(this.customNames),
      contacts: this.contacts,
    };
    fs.writeFileSync(this._dataFile(), JSON.stringify(data, null, 2), "utf-8");
  }

  // ── Renomear instância ──
  renameSession(sessionId, customName) {
    this.customNames.set(sessionId, customName);
    this._saveData();
    this._emitStatus(sessionId, this.sessions.get(sessionId)?.status || "disconnected");
    return { success: true };
  }

  // ── Contatos manuais ──
  addContact(nome, numero) {
    const clean = String(numero).replace(/\D/g, "");
    if (!clean) return { success: false, message: "Número inválido" };
    const exists = this.contacts.find((c) => c.numero === clean);
    if (exists) return { success: false, message: "Contato já existe" };
    this.contacts.push({ nome, numero: clean, contacted: false, contactedAt: null, contactedVia: null });
    this._saveData();
    return { success: true, contact: { nome, numero: clean, contacted: false, contactedAt: null, contactedVia: null } };
  }

  removeContact(numero) {
    const clean = String(numero).replace(/\D/g, "");
    this.contacts = this.contacts.filter((c) => c.numero !== clean);
    this._saveData();
    return { success: true };
  }

  markContacted(numero, sessionId) {
    const clean = String(numero).replace(/\D/g, "");
    const contact = this.contacts.find((c) => c.numero === clean);
    if (!contact) return { success: false, message: "Contato não encontrado" };
    contact.contacted = true;
    contact.contactedAt = Date.now();
    contact.contactedVia = sessionId;
    this._saveData();
    return { success: true, contact };
  }

  getContacts() { return this.contacts; }

  getPendingContacts() {
    return this.contacts.filter((c) => !c.contacted);
  }

  getContactedContacts() {
    return this.contacts.filter((c) => c.contacted);
  }

  // ── Formatar telefone legível ──
  _formatPhone(jid) {
    if (!jid) return null;
    const num = jid.split("@")[0].split(":")[0];
    if (num.length >= 12) {
      return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
    }
    return `+${num}`;
  }

  // ── Obter status de todas as instâncias ──
  getStatuses() {
    const statuses = {};
    for (let i = 1; i <= MAX_INSTANCES; i++) {
      const id = `session-${i}`;
      const sess = this.sessions.get(id);
      statuses[id] = {
        id,
        index: i,
        status: sess ? sess.status : "disconnected",
        jid: sess ? sess.jid : null,
        name: sess ? sess.name : null,
        customName: this.customNames.get(id) || null,
        phone: sess ? this._formatPhone(sess.jid) : null,
      };
    }
    return statuses;
  }

  // ── Iniciar instância ──
  async startSession(sessionId) {
    if (this.sessions.has(sessionId) && this.sessions.get(sessionId).status === "open") {
      return { success: false, message: "Session already connected" };
    }

    this._emitStatus(sessionId, "connecting");

    try {
      const sessionPath = path.join(SESSION_DIR, sessionId);
      fs.mkdirSync(sessionPath, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      const idx = parseInt(sessionId.split("-")[1], 10) - 1;
      const browser = BROWSER_PROFILES[idx % BROWSER_PROFILES.length];

      const sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        browser,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
      });

      // ── Eventos de conexão ──
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", (update) => {
        this._handleConnectionUpdate(sessionId, sock, update, saveCreds);
      });

      // ── Eventos de mensagem ──
      sock.ev.on("messages.upsert", ({ messages: msgs, type }) => {
        if (type !== "notify") return;
        for (const msg of msgs) {
          if (msg.key.fromMe && !msg.message) continue;
          this._storeMessage(sessionId, msg);
          this.io.emit("message:new", {
            sessionId,
            message: this._formatMessage(sessionId, msg),
          });
        }
      });

      sock.ev.on("messages.update", (updates) => {
        for (const update of updates) {
          this.io.emit("message:update", { sessionId, update });
        }
      });

      this.sessions.set(sessionId, { sock, status: "connecting", jid: null, name: null });
      return { success: true, message: "Connecting..." };
    } catch (err) {
      console.error(`[${sessionId}] Start error:`, err.message);
      this._emitStatus(sessionId, "error");
      return { success: false, message: err.message };
    }
  }

  // ── Tratar atualizações de conexão ──
  _handleConnectionUpdate(sessionId, sock, update, saveCreds) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      QRCode.toDataURL(qr, { width: 280, margin: 2 })
        .then((url) => {
          this.io.emit("qr:update", { sessionId, qr: url });
          this._emitStatus(sessionId, "qr");
        })
        .catch(() => {});
    }

    if (connection === "open") {
      this.retryCount.set(sessionId, 0);
      const jid = sock.user?.id;
      const name = sock.user?.name || "Unknown";
      const sess = this.sessions.get(sessionId);
      if (sess) {
        sess.status = "open";
        sess.jid = jid;
        sess.name = name;
      }
      this._emitStatus(sessionId, "open");
      console.log(`[${sessionId}] Connected as ${name} (${jid})`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;

      if (code === reason.loggedOut) {
        // Limpar sessão se logout
        this._clearSession(sessionId);
        this._emitStatus(sessionId, "disconnected");
        console.log(`[${sessionId}] Logged out. Session cleared.`);
      } else {
        // Reconexão com backoff exponencial
        const retries = (this.retryCount.get(sessionId) || 0) + 1;
        this.retryCount.set(sessionId, retries);
        const delay = Math.min(1000 * Math.pow(2, retries), 60000);
        console.log(`[${sessionId}] Reconnecting in ${delay}ms (attempt ${retries})...`);
        this._emitStatus(sessionId, "reconnecting");
        setTimeout(() => this.startSession(sessionId), delay);
      }
    }
  }

  // ── Desconectar instância ──
  async stopSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return { success: false, message: "Session not found" };
    try {
      await sess.sock.logout();
    } catch (e) {
      try { sess.sock.end(); } catch (_) {}
    }
    this._clearSession(sessionId);
    this._emitStatus(sessionId, "disconnected");
    return { success: true, message: "Disconnected" };
  }

  _clearSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (sess) {
      try { sess.sock.end(); } catch (_) {}
    }
    this.sessions.delete(sessionId);
    const sessionPath = path.join(SESSION_DIR, sessionId);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  _emitStatus(sessionId, status) {
    const sess = this.sessions.get(sessionId);
    if (sess) sess.status = status;
    this.io.emit("session:status", {
      sessionId,
      status,
      jid: sess?.jid || null,
      name: sess?.name || null,
      customName: this.customNames.get(sessionId) || null,
      phone: sess ? this._formatPhone(sess.jid) : null,
    });
  }

  // ── Envio de mensagens ──
  async sendText(sessionId, jid, text) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status !== "open") {
      return { success: false, message: "Session not connected" };
    }
    try {
      const formattedJid = this._formatJid(jid);
      const sent = await sess.sock.sendMessage(formattedJid, { text });
      return { success: true, message: sent };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async sendImage(sessionId, jid, filePath, caption) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status !== "open") return { success: false, message: "Not connected" };
    try {
      const formattedJid = this._formatJid(jid);
      const buffer = fs.readFileSync(filePath);
      const sent = await sess.sock.sendMessage(formattedJid, {
        image: buffer,
        caption: caption || "",
      });
      return { success: true, message: sent };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async sendAudio(sessionId, jid, filePath) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status !== "open") return { success: false, message: "Not connected" };
    try {
      const formattedJid = this._formatJid(jid);
      const buffer = fs.readFileSync(filePath);
      const sent = await sess.sock.sendMessage(formattedJid, {
        audio: buffer,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
      return { success: true, message: sent };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async sendDocument(sessionId, jid, filePath, fileName) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status !== "open") return { success: false, message: "Not connected" };
    try {
      const formattedJid = this._formatJid(jid);
      const buffer = fs.readFileSync(filePath);
      const mime = require("mime-types");
      const mimetype = mime.lookup(filePath) || "application/octet-stream";
      const sent = await sess.sock.sendMessage(formattedJid, {
        document: buffer,
        mimetype,
        fileName: fileName || path.basename(filePath),
      });
      return { success: true, message: sent };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── Mensagem Store ──
  _storeMessage(sessionId, msg) {
    const chatJid = msg.key.remoteJid;
    if (!chatJid) return;
    if (!this.messageStore.has(sessionId)) {
      this.messageStore.set(sessionId, new Map());
    }
    const chatMap = this.messageStore.get(sessionId);
    if (!chatMap.has(chatJid)) chatMap.set(chatJid, []);
    const arr = chatMap.get(chatJid);
    arr.push(this._formatMessage(sessionId, msg));
    if (arr.length > 200) arr.shift(); // manter últimas 200 por chat
  }

  _formatMessage(sessionId, msg) {
    const content = msg.message || {};
    let type = "unknown";
    let body = "";
    let mediaUrl = null;

    if (content.conversation) {
      type = "text"; body = content.conversation;
    } else if (content.extendedTextMessage) {
      type = "text"; body = content.extendedTextMessage.text || "";
    } else if (content.imageMessage) {
      type = "image"; body = content.imageMessage.caption || "[Image]";
    } else if (content.audioMessage) {
      type = "audio"; body = "[Audio]";
    } else if (content.videoMessage) {
      type = "video"; body = content.videoMessage.caption || "[Video]";
    } else if (content.documentMessage) {
      type = "document"; body = content.documentMessage.fileName || "[Document]";
    } else if (content.stickerMessage) {
      type = "sticker"; body = "[Sticker]";
    }

    return {
      id: msg.key.id,
      sessionId,
      chatJid: msg.key.remoteJid,
      fromMe: msg.key.fromMe || false,
      pushName: msg.pushName || "",
      type,
      body,
      mediaUrl,
      timestamp: (msg.messageTimestamp?.low || msg.messageTimestamp || Date.now() / 1000) * 1000,
    };
  }

  getChats() {
    const chats = new Map();
    for (const [sessionId, chatMap] of this.messageStore) {
      for (const [jid, messages] of chatMap) {
        const existing = chats.get(jid);
        const lastMsg = messages[messages.length - 1];
        if (!existing || lastMsg.timestamp > existing.lastTimestamp) {
          chats.set(jid, {
            jid,
            lastMessage: lastMsg.body,
            lastTimestamp: lastMsg.timestamp,
            lastSessionId: sessionId,
            pushName: lastMsg.pushName || jid.split("@")[0],
            sessions: existing ? [...existing.sessions, sessionId] : [sessionId],
          });
        } else if (existing && !existing.sessions.includes(sessionId)) {
          existing.sessions.push(sessionId);
        }
      }
    }
    return Array.from(chats.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  getChatMessages(jid) {
    const all = [];
    for (const [sessionId, chatMap] of this.messageStore) {
      const msgs = chatMap.get(jid) || [];
      all.push(...msgs);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  _formatJid(number) {
    let clean = String(number).replace(/\D/g, "");
    if (!clean.includes("@")) {
      clean = clean + "@s.whatsapp.net";
    }
    return clean;
  }
}

module.exports = SessionManager;
