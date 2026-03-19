const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const db = require("./database");

const SESSION_DIR = path.resolve(process.env.SESSION_DIR || "./sessions");
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || "5", 10);
const KANBAN_STAGES = ['novo','tentativa_de_contato','conectado','consultoria_agendada','consultoria_realizada','no_show','perdido'];

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
    this.messageStore = new Map(); // cache em memória: sessionId -> Map(chatJid -> messages[])
    this.customNames = new Map();
    this.sentMediaUrls = new Map();
    this.contacts = []; // cache local
    this.logger = pino({ level: process.env.LOG_LEVEL || "error" });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  // ── Inicialização async (chamado no server.js) ──
  async init() {
    const connected = await db.testConnection();
    if (!connected) {
      console.error("[SessionManager] Não foi possível conectar ao Supabase. Verifique as credenciais no .env");
      console.error("[SessionManager] Usando fallback local (dados não serão persistidos no banco)");
      this._loadDataFromFile();
      return;
    }

    // Migrar dados do arquivo local se existirem
    await this._migrateLocalData();

    // Carregar dados do Supabase
    this.contacts = await db.getContacts();
    this.customNames = await db.getSessionNames();
    console.log(`[SessionManager] Carregados ${this.contacts.length} contatos e ${this.customNames.size} nomes de sessão do Supabase`);
  }

  // ── Migração do _appdata.json para Supabase ──
  async _migrateLocalData() {
    const dataFile = path.join(SESSION_DIR, "_appdata.json");
    try {
      if (!fs.existsSync(dataFile)) return;
      const raw = fs.readFileSync(dataFile, "utf-8");
      const data = JSON.parse(raw);

      const contacts = (data.contacts || []).map(c => ({
        ...c,
        stage: c.stage || (c.contacted ? 'tentativa_de_contato' : 'novo'),
        stageUpdatedAt: c.stageUpdatedAt || c.contactedAt || null,
        notes: c.notes || '',
      }));

      const customNames = new Map();
      if (data.customNames) {
        for (const [k, v] of Object.entries(data.customNames)) customNames.set(k, v);
      }

      if (contacts.length > 0 || customNames.size > 0) {
        await db.migrateFromFile(contacts, customNames);
        // Renomear o arquivo para não migrar novamente
        const backupPath = dataFile + ".migrated";
        fs.renameSync(dataFile, backupPath);
        console.log(`[SessionManager] Arquivo local migrado e renomeado para ${backupPath}`);
      }
    } catch (err) {
      console.error("[SessionManager] Erro na migração:", err.message);
    }
  }

  // Fallback se Supabase não estiver disponível
  _loadDataFromFile() {
    try {
      const raw = fs.readFileSync(path.join(SESSION_DIR, "_appdata.json"), "utf-8");
      const data = JSON.parse(raw);
      if (data.customNames) {
        for (const [k, v] of Object.entries(data.customNames)) this.customNames.set(k, v);
      }
      if (data.contacts) {
        this.contacts = data.contacts.map(c => ({
          ...c,
          stage: c.stage || (c.contacted ? 'tentativa_de_contato' : 'novo'),
          stageUpdatedAt: c.stageUpdatedAt || c.contactedAt || null,
          notes: c.notes || '',
        }));
      }
    } catch (_) {}
  }

  // ── Renomear instância ──
  async renameSession(sessionId, customName) {
    this.customNames.set(sessionId, customName);
    await db.saveSessionName(sessionId, customName);
    this._emitStatus(sessionId, this.sessions.get(sessionId)?.status || "disconnected");
    return { success: true };
  }

  // ── Contatos ──
  async addContact(nome, numero) {
    const clean = String(numero).replace(/\D/g, "");
    if (!clean) return { success: false, message: "Número inválido" };

    const result = await db.addContact(nome, clean);
    if (result.success) {
      this.contacts = await db.getContacts(); // refresh cache
    }
    return result;
  }

  async removeContact(numero) {
    const clean = String(numero).replace(/\D/g, "");
    const result = await db.removeContact(clean);
    if (result.success) {
      this.contacts = this.contacts.filter(c => c.numero !== clean);
    }
    return result;
  }

  async markContacted(numero, sessionId) {
    const clean = String(numero).replace(/\D/g, "");
    const result = await db.markContacted(clean, sessionId);
    if (result.success) {
      // Atualizar cache local
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async getContacts() {
    this.contacts = await db.getContacts();
    return this.contacts;
  }

  async getPendingContacts() {
    const all = await db.getContacts();
    return all.filter(c => !c.contacted);
  }

  async getContactedContacts() {
    const all = await db.getContacts();
    return all.filter(c => c.contacted);
  }

  async updateContactStage(numero, stage) {
    if (!KANBAN_STAGES.includes(stage)) return { success: false, message: 'Estágio inválido' };
    const clean = String(numero).replace(/\D/g, '');
    const result = await db.updateStage(clean, stage);
    if (result.success) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async updateContactNotes(numero, notes) {
    const clean = String(numero).replace(/\D/g, '');
    const result = await db.updateNotes(clean, notes);
    if (result.success) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async getKanbanBoard() {
    return await db.getKanbanBoard();
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
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "open") {
      return { success: false, message: "Session already connected" };
    }

    // Limpar socket anterior se existir (evita sockets duplicados na reconexão)
    if (existing?.sock) {
      try { existing.sock.ev.removeAllListeners(); } catch (_) {}
      try { existing.sock.end(); } catch (_) {}
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
      sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
        if (type !== "notify") return;
        for (const msg of msgs) {
          if (msg.key.fromMe && !msg.message) continue;
          const formatted = await this._storeMessage(sessionId, msg);
          if (!formatted) continue;
          // Não emitir fromMe — o frontend já mostra localmente
          if (!msg.key.fromMe) {
            this.io.emit("message:new", {
              sessionId,
              message: formatted,
            });
          }
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

    // Ignorar eventos de sockets antigos (já substituídos por reconexão)
    const currentSess = this.sessions.get(sessionId);
    if (currentSess && currentSess.sock !== sock) return;

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
      const MAX_RETRIES = 10;

      if (code === reason.loggedOut || code === reason.forbidden) {
        this._clearSession(sessionId);
        this._emitStatus(sessionId, "disconnected");
        console.log(`[${sessionId}] Logged out (code ${code}). Session cleared.`);
      } else {
        const retries = (this.retryCount.get(sessionId) || 0) + 1;
        this.retryCount.set(sessionId, retries);

        if (retries > MAX_RETRIES) {
          console.log(`[${sessionId}] Max retries (${MAX_RETRIES}) reached. Clearing session.`);
          this._clearSession(sessionId);
          this._emitStatus(sessionId, "disconnected");
          this.retryCount.set(sessionId, 0);
          return;
        }

        const delay = Math.min(1000 * Math.pow(2, retries), 60000);
        console.log(`[${sessionId}] Reconnecting in ${delay}ms (attempt ${retries}/${MAX_RETRIES}, code: ${code})...`);
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
      if (sess.sock) {
        sess.sock.ev.removeAllListeners();
        await sess.sock.logout();
      }
    } catch (e) {
      try { sess.sock.end(); } catch (_) {}
    }
    this._clearSession(sessionId);
    this._emitStatus(sessionId, "disconnected");
    return { success: true, message: "Disconnected" };
  }

  // ── Remover instância completamente ──
  async removeSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (sess?.sock) {
      try { sess.sock.ev.removeAllListeners(); } catch (_) {}
      try { await sess.sock.logout(); } catch (_) {}
      try { sess.sock.end(); } catch (_) {}
    }
    this.sessions.delete(sessionId);
    this.retryCount.delete(sessionId);
    this.messageStore.delete(sessionId);
    this.customNames.delete(sessionId);
    await db.deleteSessionName(sessionId);
    const sessionPath = path.join(SESSION_DIR, sessionId);
    fs.rmSync(sessionPath, { recursive: true, force: true });
    this._emitStatus(sessionId, "disconnected");
    return { success: true, message: "Instância removida" };
  }

  _clearSession(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (sess?.sock) {
      try { sess.sock.ev.removeAllListeners(); } catch (_) {}
      try { sess.sock.end(); } catch (_) {}
    }
    this.sessions.delete(sessionId);
    this.retryCount.delete(sessionId);
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
      const mediaUrl = `/uploads/${path.basename(filePath)}`;
      if (sent?.key?.id) this.sentMediaUrls.set(sent.key.id, mediaUrl);
      return { success: true, message: sent, mediaUrl };
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
      const mime = require("mime-types");
      const detectedMime = mime.lookup(filePath) || "audio/mpeg";
      const isVoice = filePath.endsWith(".ogg") || filePath.endsWith(".opus") || filePath.endsWith(".webm");
      const sent = await sess.sock.sendMessage(formattedJid, {
        audio: buffer,
        mimetype: isVoice ? "audio/ogg; codecs=opus" : detectedMime,
        ptt: isVoice,
      });
      const mediaUrl = `/uploads/${path.basename(filePath)}`;
      if (sent?.key?.id) this.sentMediaUrls.set(sent.key.id, mediaUrl);
      return { success: true, message: sent, mediaUrl };
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
      const mediaUrl = `/uploads/${path.basename(filePath)}`;
      if (sent?.key?.id) this.sentMediaUrls.set(sent.key.id, mediaUrl);
      return { success: true, message: sent, mediaUrl };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ── Mensagem Store (cache + Supabase) ──
  async _storeMessage(sessionId, msg) {
    const chatJid = msg.key.remoteJid;
    if (!chatJid) return null;
    if (!this.messageStore.has(sessionId)) {
      this.messageStore.set(sessionId, new Map());
    }
    const chatMap = this.messageStore.get(sessionId);
    if (!chatMap.has(chatJid)) chatMap.set(chatJid, []);
    const arr = chatMap.get(chatJid);
    const formatted = this._formatMessage(sessionId, msg);

    const isMedia = ["image", "video", "audio", "document", "sticker"].includes(formatted.type);

    if (isMedia) {
      if (msg.key.fromMe) {
        if (this.sentMediaUrls.has(msg.key.id)) {
          formatted.mediaUrl = this.sentMediaUrls.get(msg.key.id);
          this.sentMediaUrls.delete(msg.key.id);
        }
      } else {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          if (buffer) {
            const ext = this._getMediaExtension(formatted.type, msg.message);
            const filename = `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
            const uploadsDir = path.join(__dirname, "..", "uploads");
            fs.mkdirSync(uploadsDir, { recursive: true });
            fs.writeFileSync(path.join(uploadsDir, filename), buffer);
            formatted.mediaUrl = `/uploads/${filename}`;
          }
        } catch (err) {
          console.error(`[${sessionId}] Media download error:`, err.message);
        }
      }
    }

    // Cache em memória
    arr.push(formatted);
    if (arr.length > 500) arr.shift();

    // Persistir no Supabase (fire-and-forget, não bloqueia)
    db.saveMessage(formatted).catch(err => {
      console.error(`[${sessionId}] DB save error:`, err.message);
    });

    return formatted;
  }

  _getMediaExtension(type, content) {
    if (!content) return "";
    switch (type) {
      case "image": return (content.imageMessage?.mimetype || "").includes("png") ? ".png" : ".jpg";
      case "video": return ".mp4";
      case "audio": return ".ogg";
      case "document": {
        const mime = require("mime-types");
        const ext = mime.extension(content.documentMessage?.mimetype || "");
        return ext ? `.${ext}` : "";
      }
      case "sticker": return ".webp";
      default: return "";
    }
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

  // ── Chats (Supabase como fonte principal) ──
  async getChats() {
    // Tentar buscar do Supabase
    const dbChats = await db.getChats();
    if (dbChats.length > 0) return dbChats;

    // Fallback: cache em memória
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

  async getChatMessages(jid) {
    // Buscar do Supabase (todas as mensagens persistidas)
    const dbMessages = await db.getMessages(jid);
    if (dbMessages.length > 0) return dbMessages;

    // Fallback: cache em memória
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
