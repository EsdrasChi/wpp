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
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const db = require("./database");

const SESSION_DIR = path.resolve(process.env.SESSION_DIR || "./sessions");
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || "5", 10);
const KANBAN_STAGES = ['novo','tentativa_de_contato','conectado','conectado_com_secretario','consultoria_agendada','consultoria_realizada','no_show','perdido'];

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
    this.groupMetadata = new Map(); // cache: groupJid -> { subject, participants }
    this.lidToPhone = new Map(); // LID -> phone JID mapping (e.g. "281380604874829@lid" -> "5531999999999@s.whatsapp.net")
    this.useFallback = false; // true quando Supabase não está disponível
    this.logger = pino({ level: process.env.LOG_LEVEL || "error" });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  // ── Inicialização async (chamado no server.js) ──
  async init() {
    const connected = await db.testConnection();
    if (!connected) {
      console.error("[SessionManager] Não foi possível conectar ao Supabase. Verifique as credenciais no .env");
      console.error("[SessionManager] Usando fallback local (dados persistidos em arquivo)");
      this.useFallback = true;
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
      console.log(`[SessionManager] Fallback: ${this.contacts.length} contatos, ${this.customNames.size} nomes de sessão carregados do arquivo`);
    } catch (_) {
      console.log("[SessionManager] Fallback: nenhum arquivo _appdata.json encontrado, iniciando vazio");
    }
  }

  _saveDataToFile() {
    try {
      const data = {
        contacts: this.contacts,
        customNames: Object.fromEntries(this.customNames),
      };
      fs.writeFileSync(path.join(SESSION_DIR, "_appdata.json"), JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[SessionManager] Erro ao salvar _appdata.json:", err.message);
    }
  }

  // ── Renomear instância ──
  async renameSession(sessionId, customName) {
    this.customNames.set(sessionId, customName);
    if (this.useFallback) {
      this._saveDataToFile();
    } else {
      await db.saveSessionName(sessionId, customName);
    }
    this._emitStatus(sessionId, this.sessions.get(sessionId)?.status || "disconnected");
    return { success: true };
  }

  // ── Contatos ──
  async addContact(nome, numero) {
    const clean = String(numero).replace(/\D/g, "");
    if (!clean) return { success: false, message: "Número inválido" };

    if (this.useFallback) {
      if (this.contacts.find(c => c.numero === clean)) {
        return { success: false, message: "Contato já existe" };
      }
      const contact = {
        nome, numero: clean, contacted: false, contactedAt: null,
        contactedVia: null, stage: "novo", stageUpdatedAt: Date.now(), notes: "",
      };
      this.contacts.push(contact);
      this._saveDataToFile();
      return { success: true, contact };
    }

    const result = await db.addContact(nome, clean);
    if (result.success) {
      this.contacts = await db.getContacts();
    }
    return result;
  }

  async removeContact(numero) {
    const clean = String(numero).replace(/\D/g, "");
    if (this.useFallback) {
      this.contacts = this.contacts.filter(c => c.numero !== clean);
      this._saveDataToFile();
      return { success: true };
    }
    const result = await db.removeContact(clean);
    if (result.success) {
      this.contacts = this.contacts.filter(c => c.numero !== clean);
    }
    return result;
  }

  async markContacted(numero, sessionId) {
    const clean = String(numero).replace(/\D/g, "");
    if (this.useFallback) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx < 0) return { success: false, message: "Contato não encontrado" };
      const now = Date.now();
      this.contacts[idx].contacted = true;
      this.contacts[idx].contactedAt = now;
      this.contacts[idx].contactedVia = sessionId;
      if (this.contacts[idx].stage === "novo") {
        this.contacts[idx].stage = "tentativa_de_contato";
        this.contacts[idx].stageUpdatedAt = now;
      }
      this._saveDataToFile();
      return { success: true, contact: this.contacts[idx] };
    }
    const result = await db.markContacted(clean, sessionId);
    if (result.success) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async getContacts() {
    if (this.useFallback) return this.contacts;
    this.contacts = await db.getContacts();
    return this.contacts;
  }

  async getPendingContacts() {
    if (this.useFallback) return this.contacts.filter(c => !c.contacted);
    const all = await db.getContacts();
    return all.filter(c => !c.contacted);
  }

  async getContactedContacts() {
    if (this.useFallback) return this.contacts.filter(c => c.contacted);
    const all = await db.getContacts();
    return all.filter(c => c.contacted);
  }

  async updateContactStage(numero, stage) {
    if (!KANBAN_STAGES.includes(stage)) return { success: false, message: 'Estágio inválido' };
    const clean = String(numero).replace(/\D/g, '');
    if (this.useFallback) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx < 0) return { success: false, message: 'Contato não encontrado' };
      this.contacts[idx].stage = stage;
      this.contacts[idx].stageUpdatedAt = Date.now();
      this._saveDataToFile();
      return { success: true, contact: this.contacts[idx] };
    }
    const result = await db.updateStage(clean, stage);
    if (result.success) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async updateContactNotes(numero, notes) {
    const clean = String(numero).replace(/\D/g, '');
    if (this.useFallback) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx < 0) return { success: false, message: 'Contato não encontrado' };
      this.contacts[idx].notes = notes || '';
      this._saveDataToFile();
      return { success: true, contact: this.contacts[idx] };
    }
    const result = await db.updateNotes(clean, notes);
    if (result.success) {
      const idx = this.contacts.findIndex(c => c.numero === clean);
      if (idx >= 0) this.contacts[idx] = result.contact;
    }
    return result;
  }

  async getKanbanBoard() {
    if (this.useFallback) {
      const stages = {
        novo: [], tentativa_de_contato: [], conectado: [],
        conectado_com_secretario: [], consultoria_agendada: [],
        consultoria_realizada: [], no_show: [], perdido: [],
      };
      for (const c of this.contacts) {
        const s = c.stage || "novo";
        if (stages[s]) stages[s].push(c);
      }
      // Ordenar por stageUpdatedAt desc dentro de cada coluna
      for (const key of Object.keys(stages)) {
        stages[key].sort((a, b) => (b.stageUpdatedAt || 0) - (a.stageUpdatedAt || 0));
      }
      return stages;
    }
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

          // Buscar nome do grupo se for mensagem de grupo
          let groupName = null;
          if (formatted.isGroup) {
            groupName = await this._getGroupName(sessionId, formatted.chatJid);
          }

          this.io.emit("message:new", {
            sessionId,
            message: formatted,
            groupName,
          });
        }
      });

      sock.ev.on("messages.update", (updates) => {
        for (const update of updates) {
          this.io.emit("message:update", { sessionId, update });
        }
      });

      // ── LID→Phone mappings de contatos e histórico ──
      sock.ev.on("contacts.upsert", (contacts) => {
        for (const c of contacts) {
          if (c.lid && c.id && String(c.id).endsWith("@s.whatsapp.net")) {
            const lid = this._stripDeviceSuffix(c.lid);
            const phone = this._stripDeviceSuffix(c.id);
            this.lidToPhone.set(lid, phone);
          }
          if (c.lid && c.jid) {
            const lid = this._stripDeviceSuffix(c.lid);
            const phone = this._stripDeviceSuffix(c.jid);
            if (phone.endsWith("@s.whatsapp.net")) {
              this.lidToPhone.set(lid, phone);
            }
          }
        }
      });

      sock.ev.on("contacts.update", (contacts) => {
        for (const c of contacts) {
          if (c.lid && c.id && String(c.id).endsWith("@s.whatsapp.net")) {
            const lid = this._stripDeviceSuffix(c.lid);
            const phone = this._stripDeviceSuffix(c.id);
            this.lidToPhone.set(lid, phone);
          }
        }
      });

      // Evento direto de LID→phone quando contato compartilha número
      sock.ev.on("chats.phoneNumberShare", (data) => {
        if (data && data.lid && data.jid) {
          const lid = this._stripDeviceSuffix(data.lid);
          const phone = this._stripDeviceSuffix(data.jid);
          if (lid.endsWith("@lid") && phone.endsWith("@s.whatsapp.net")) {
            this.lidToPhone.set(lid, phone);
            console.log(`[${sessionId}] Phone shared: ${lid} -> ${phone}`);
          }
        }
      });

      sock.ev.on("messaging-history.set", ({ contacts }) => {
        if (!contacts) return;
        for (const c of contacts) {
          if (c.lid && c.id && String(c.id).endsWith("@s.whatsapp.net")) {
            this.lidToPhone.set(this._stripDeviceSuffix(c.lid), this._stripDeviceSuffix(c.id));
          }
          if (c.lid && c.jid) {
            this.lidToPhone.set(this._stripDeviceSuffix(c.lid), this._stripDeviceSuffix(c.jid));
          }
        }
        if (this.lidToPhone.size > 0) {
          console.log(`[${sessionId}] LID map now has ${this.lidToPhone.size} entries`);
        }
      });

      // ── Eventos de grupo ──
      sock.ev.on("groups.update", (updates) => {
        for (const update of updates) {
          const groupJid = update.id;
          if (!groupJid) continue;
          const cached = this.groupMetadata.get(groupJid);
          if (cached) {
            if (update.subject !== undefined) cached.subject = update.subject;
            if (update.desc !== undefined) cached.desc = update.desc;
            if (update.announce !== undefined) cached.announce = !!update.announce;
            if (update.restrict !== undefined) cached.restrict = !!update.restrict;
            cached.fetchedAt = Date.now();
            this.groupMetadata.set(groupJid, cached);
          }
          const info = this._buildGroupInfoPayload(groupJid);
          if (info) this.io.emit("group:updated", info);
        }
      });

      sock.ev.on("group-participants.update", async (event) => {
        const { id: groupJid } = event;
        if (!groupJid) return;
        await this._fetchAndCacheGroupMetadata(sessionId, groupJid, true);
        const info = this._buildGroupInfoPayload(groupJid);
        if (info) this.io.emit("group:updated", info);
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
      // Mapear nosso próprio LID → phone
      if (sock.user?.lid) {
        const ownLid = this._stripDeviceSuffix(sock.user.lid);
        const ownPhone = this._stripDeviceSuffix(jid);
        if (ownLid.endsWith("@lid") && ownPhone.endsWith("@s.whatsapp.net")) {
          this.lidToPhone.set(ownLid, ownPhone);
          console.log(`[${sessionId}] Own LID mapped: ${ownLid} -> ${ownPhone}`);
        }
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
    if (this.useFallback) {
      this._saveDataToFile();
    } else {
      await db.deleteSessionName(sessionId);
    }
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
      const isAlreadyOgg = filePath.endsWith(".ogg") || filePath.endsWith(".opus");
      const needsConversion = !isAlreadyOgg && (filePath.endsWith(".webm") || filePath.endsWith(".mp4") || filePath.endsWith(".m4a") || filePath.endsWith(".mp3") || filePath.endsWith(".wav"));

      let audioPath = filePath;
      if (needsConversion) {
        const oggPath = filePath.replace(/\.[^.]+$/, ".ogg");
        await new Promise((resolve, reject) => {
          execFile(ffmpegPath, [
            "-y", "-i", filePath,
            "-ac", "1",
            "-ar", "48000",
            "-c:a", "libopus",
            "-b:a", "64k",
            "-f", "ogg",
            oggPath,
          ], (err) => err ? reject(err) : resolve());
        });
        audioPath = oggPath;
      }

      const buffer = fs.readFileSync(audioPath);
      const sent = await sess.sock.sendMessage(formattedJid, {
        audio: buffer,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });

      // Cleanup converted file
      if (needsConversion && audioPath !== filePath) {
        fs.unlink(audioPath, () => {});
      }

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
    const rawJid = msg.key.remoteJid;
    if (!rawJid) return null;
    // Aprender LID mapping ANTES de resolver (para ter dados disponíveis)
    this._learnLidMapping(msg);
    const chatJid = this._resolveJid(rawJid);
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
    if (!this.useFallback) {
      db.saveMessage(formatted).catch(err => {
        console.error(`[${sessionId}] DB save error:`, err.message);
      });
    }

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

    // 1. Aprender mapeamento LID→Phone com dados desta mensagem
    this._learnLidMapping(msg);

    // 2. Resolver chatJid: LID → phone, remover sufixo de dispositivo
    const chatJid = this._resolveJid(msg.key.remoteJid);

    // 3. Resolver participant (grupo): LID → phone
    let participant = msg.key.participant || null;
    if (participant) {
      // Tentar usar participantPn diretamente (mais confiável)
      if (msg.key.participantPn) {
        participant = this._stripDeviceSuffix(msg.key.participantPn);
      } else {
        participant = this._resolveJid(participant);
      }
    }

    return {
      id: msg.key.id,
      sessionId,
      chatJid,
      fromMe: msg.key.fromMe || false,
      pushName: msg.pushName || "",
      type,
      body,
      mediaUrl,
      timestamp: (msg.messageTimestamp?.low || msg.messageTimestamp || Date.now() / 1000) * 1000,
      isGroup: chatJid ? chatJid.endsWith("@g.us") : false,
      participant,
    };
  }

  // ── Chats (Supabase como fonte principal, fallback para memória) ──
  async getChats() {
    let chatList = this.useFallback ? [] : await db.getChats();

    // Fallback: cache em memória
    if (chatList.length === 0) {
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
      chatList = Array.from(chats.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    }

    // Resolver LIDs no chat list (mensagens antigas que podem ter LID como chat_jid)
    for (const chat of chatList) {
      if (chat.jid && String(chat.jid).endsWith("@lid")) {
        const resolved = this.lidToPhone.get(this._stripDeviceSuffix(chat.jid));
        if (resolved) {
          chat.jid = resolved;
        }
      }
    }

    // Deduplicar chats que agora têm o mesmo JID (após resolução de LID)
    const deduped = new Map();
    for (const chat of chatList) {
      const existing = deduped.get(chat.jid);
      if (!existing || chat.lastTimestamp > existing.lastTimestamp) {
        deduped.set(chat.jid, chat);
      }
    }

    // Deduplicar por pushName: se @lid e @s.whatsapp.net têm mesmo pushName, manter só o phone
    const phoneByName = new Map(); // pushName -> chat com @s.whatsapp.net
    for (const chat of deduped.values()) {
      if (chat.pushName && chat.jid && !String(chat.jid).endsWith("@lid") && !String(chat.jid).endsWith("@g.us")) {
        phoneByName.set(chat.pushName, chat);
      }
    }
    for (const [jid, chat] of deduped) {
      if (String(jid).endsWith("@lid") && chat.pushName && phoneByName.has(chat.pushName)) {
        // Mesclar timestamp mais recente no chat phone
        const phoneChat = phoneByName.get(chat.pushName);
        if (chat.lastTimestamp > phoneChat.lastTimestamp) {
          phoneChat.lastMessage = chat.lastMessage;
          phoneChat.lastTimestamp = chat.lastTimestamp;
          phoneChat.lastSessionId = chat.lastSessionId;
        }
        deduped.delete(jid);
      }
    }

    chatList = Array.from(deduped.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    // Enriquecer com isGroup e groupName
    // Encontrar uma sessao conectada para buscar metadados de grupo
    let connectedSessionId = null;
    for (const [id, s] of this.sessions) {
      if (s.status === "open") { connectedSessionId = id; break; }
    }

    const groupFetchPromises = [];
    for (const chat of chatList) {
      chat.isGroup = chat.jid ? chat.jid.endsWith("@g.us") : false;
      if (chat.isGroup) {
        const cached = this.groupMetadata.get(chat.jid);
        if (cached) {
          chat.groupName = cached.subject;
        } else if (connectedSessionId) {
          // Buscar nome do grupo de uma sessao conectada
          groupFetchPromises.push(
            this._getGroupName(connectedSessionId, chat.jid)
              .then(name => { chat.groupName = name; })
              .catch(() => { chat.groupName = chat.jid.split("@")[0]; })
          );
        } else {
          chat.groupName = chat.jid.split("@")[0];
        }
      }
    }

    // Aguardar busca dos nomes dos grupos (maximo 5 segundos)
    if (groupFetchPromises.length > 0) {
      await Promise.race([
        Promise.all(groupFetchPromises),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }

    return chatList;
  }

  async getChatMessages(jid) {
    // Tentar com o JID fornecido e também com possível LID reverso
    if (!this.useFallback) {
      let dbMessages = await db.getMessages(jid);
      // Se não encontrou mensagens, tentar buscar com LID (caso mensagens antigas estejam salvas com LID)
      if (dbMessages.length === 0 && jid.endsWith("@s.whatsapp.net")) {
        for (const [lid, phone] of this.lidToPhone) {
          if (phone === jid) {
            const lidMessages = await db.getMessages(lid);
            if (lidMessages.length > 0) {
              dbMessages = lidMessages;
              break;
            }
          }
        }
      }
      if (dbMessages.length > 0) return dbMessages;
    }

    // Fallback: cache em memória
    const all = [];
    for (const [sessionId, chatMap] of this.messageStore) {
      const msgs = chatMap.get(jid) || [];
      all.push(...msgs);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  async clearChat(jid) {
    if (!this.useFallback) {
      await db.deleteMessages(jid);
    }
    for (const [sessionId, chatMap] of this.messageStore) {
      chatMap.delete(jid);
    }
    return { success: true };
  }

  // Normaliza JID: remove sufixo de dispositivo E resolve LID→phone
  _normalizeJid(jid) {
    return this._resolveJid(jid);
  }

  // Aprende mapeamento LID→Phone a partir de dados da mensagem
  _learnLidMapping(msg) {
    const key = msg.key || {};
    // participantPn: telefone real quando participant é LID (mensagens de grupo)
    if (key.participant && key.participantPn) {
      const lid = this._stripDeviceSuffix(key.participant);
      const phone = this._stripDeviceSuffix(key.participantPn);
      if (lid.endsWith("@lid") && phone.endsWith("@s.whatsapp.net")) {
        this.lidToPhone.set(lid, phone);
      }
    }
    // participantLid + participantPn (quando participant já é phone)
    if (key.participantLid && key.participantPn) {
      const lid = this._stripDeviceSuffix(key.participantLid);
      const phone = this._stripDeviceSuffix(key.participantPn);
      if (lid.endsWith("@lid") && phone.endsWith("@s.whatsapp.net")) {
        this.lidToPhone.set(lid, phone);
      }
    }
    // senderLid + senderPn (mensagens 1:1)
    if (key.senderLid && key.senderPn) {
      const lid = this._stripDeviceSuffix(key.senderLid);
      const phone = this._stripDeviceSuffix(key.senderPn);
      if (lid.endsWith("@lid") && phone.endsWith("@s.whatsapp.net")) {
        this.lidToPhone.set(lid, phone);
      }
    }
    // remoteJid é LID e senderPn disponível (chat 1:1 com LID)
    if (key.remoteJid && String(key.remoteJid).endsWith("@lid") && key.senderPn) {
      const lid = this._stripDeviceSuffix(key.remoteJid);
      const phone = this._stripDeviceSuffix(key.senderPn);
      if (phone.endsWith("@s.whatsapp.net")) {
        this.lidToPhone.set(lid, phone);
      }
    }
  }

  // Remove sufixo de dispositivo sem resolver LID
  _stripDeviceSuffix(jid) {
    if (!jid) return "";
    const str = String(jid);
    if (str.endsWith("@g.us")) return str;
    return str.replace(/:\d+@/, "@");
  }

  // Resolve um JID: remove sufixo de dispositivo E resolve LID→phone se possível
  _resolveJid(jid) {
    if (!jid) return jid;
    const str = String(jid);
    if (str.endsWith("@g.us")) return str;
    const clean = str.replace(/:\d+@/, "@");
    if (clean.endsWith("@lid")) {
      const resolved = this.lidToPhone.get(clean);
      return resolved || clean; // retorna LID se não resolvido (será tratado no frontend)
    }
    return clean;
  }

  _formatJid(jid) {
    const str = String(jid);
    if (str.includes("@")) return this._resolveJid(str);
    return str.replace(/\D/g, "") + "@s.whatsapp.net";
  }

  async _getGroupName(sessionId, groupJid) {
    const meta = await this._fetchAndCacheGroupMetadata(sessionId, groupJid);
    return meta ? meta.subject : groupJid.split("@")[0];
  }

  async _fetchAndCacheGroupMetadata(sessionId, groupJid, forceRefresh = false) {
    const cached = this.groupMetadata.get(groupJid);
    // Retornar cache se fresco (< 5 min) e não forçado
    if (cached && !forceRefresh && (Date.now() - cached.fetchedAt < 300000)) {
      return cached;
    }

    const sess = this.sessions.get(sessionId);
    if (!sess || !sess.sock || sess.status !== "open") {
      return cached || null;
    }

    try {
      const metadata = await sess.sock.groupMetadata(groupJid);

      const participants = (metadata.participants || []).map(p => {
        const rawJid = this._stripDeviceSuffix(p.id || p.jid || "");
        let phone = null;
        if (rawJid.endsWith("@s.whatsapp.net")) {
          phone = rawJid.split("@")[0];
        } else if (rawJid.endsWith("@lid")) {
          const resolved = this.lidToPhone.get(rawJid);
          if (resolved) phone = resolved.split("@")[0];
        }
        // Tentar jid do participante (Baileys pode fornecer)
        if (!phone && p.jid && String(p.jid).endsWith("@s.whatsapp.net")) {
          phone = this._stripDeviceSuffix(p.jid).split("@")[0];
        }
        return {
          jid: rawJid,
          phone,
          admin: p.admin || null,
          pushName: p.notify || p.name || null,
        };
      });

      const groupData = {
        subject: metadata.subject || groupJid.split("@")[0],
        desc: metadata.desc || null,
        announce: !!metadata.announce,
        restrict: !!metadata.restrict,
        owner: metadata.owner ? this._stripDeviceSuffix(metadata.owner) : null,
        size: metadata.size || participants.length,
        participants,
        fetchedAt: Date.now(),
      };

      this.groupMetadata.set(groupJid, groupData);
      return groupData;
    } catch (err) {
      console.error(`[${sessionId}] Group metadata error for ${groupJid}:`, err.message);
      return cached || null;
    }
  }

  isUserAdminInGroup(groupJid) {
    const cached = this.groupMetadata.get(groupJid);
    if (!cached || !cached.participants) return false;

    for (const [sessionId, sess] of this.sessions) {
      if (sess.status !== "open" || !sess.sock?.user) continue;

      const userJid = this._stripDeviceSuffix(sess.sock.user.id);
      const userLid = sess.sock.user.lid ? this._stripDeviceSuffix(sess.sock.user.lid) : null;

      for (const p of cached.participants) {
        if (p.jid === userJid || (userLid && p.jid === userLid) ||
            (p.phone && userJid.startsWith(p.phone))) {
          if (p.admin === "admin" || p.admin === "superadmin") return true;
        }
      }
    }
    return false;
  }

  _buildGroupInfoPayload(groupJid) {
    const meta = this.groupMetadata.get(groupJid);
    if (!meta) return null;
    return {
      jid: groupJid,
      subject: meta.subject,
      desc: meta.desc,
      announce: meta.announce,
      restrict: meta.restrict,
      size: meta.size,
      isAdmin: this.isUserAdminInGroup(groupJid),
      participants: meta.participants,
    };
  }

  async getGroupInfo(groupJid) {
    let connectedSessionId = null;
    for (const [id, s] of this.sessions) {
      if (s.status === "open") { connectedSessionId = id; break; }
    }
    if (connectedSessionId) {
      await this._fetchAndCacheGroupMetadata(connectedSessionId, groupJid);
    }
    return this._buildGroupInfoPayload(groupJid);
  }
}

module.exports = SessionManager;
