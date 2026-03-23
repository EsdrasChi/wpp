const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[DB] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY devem estar no .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ── Contatos ──

async function getContacts() {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) { console.error("[DB] getContacts:", error.message); return []; }
  return data.map(_dbToContact);
}

async function getContactByNumero(numero) {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("numero", numero)
    .maybeSingle();
  if (error) { console.error("[DB] getContactByNumero:", error.message); return null; }
  return data ? _dbToContact(data) : null;
}

async function addContact(nome, numero) {
  const { data, error } = await supabase
    .from("contacts")
    .insert({ nome, numero, contacted: false, stage: "novo", stage_updated_at: new Date().toISOString(), notes: "" })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return { success: false, message: "Contato já existe" };
    console.error("[DB] addContact:", error.message);
    return { success: false, message: error.message };
  }
  return { success: true, contact: _dbToContact(data) };
}

async function removeContact(numero) {
  const { error } = await supabase.from("contacts").delete().eq("numero", numero);
  if (error) { console.error("[DB] removeContact:", error.message); return { success: false }; }
  return { success: true };
}

async function markContacted(numero, sessionId) {
  const now = new Date().toISOString();
  // Buscar estágio atual
  const existing = await getContactByNumero(numero);
  if (!existing) return { success: false, message: "Contato não encontrado" };

  const updates = {
    contacted: true,
    contacted_at: now,
    contacted_via: sessionId,
  };
  if (existing.stage === "novo") {
    updates.stage = "tentativa_de_contato";
    updates.stage_updated_at = now;
  }

  const { data, error } = await supabase
    .from("contacts")
    .update(updates)
    .eq("numero", numero)
    .select()
    .single();
  if (error) { console.error("[DB] markContacted:", error.message); return { success: false, message: error.message }; }
  return { success: true, contact: _dbToContact(data) };
}

async function updateStage(numero, stage) {
  const { data, error } = await supabase
    .from("contacts")
    .update({ stage, stage_updated_at: new Date().toISOString() })
    .eq("numero", numero)
    .select()
    .single();
  if (error) { console.error("[DB] updateStage:", error.message); return { success: false, message: error.message }; }
  return { success: true, contact: _dbToContact(data) };
}

async function updateNotes(numero, notes) {
  const { data, error } = await supabase
    .from("contacts")
    .update({ notes: notes || "" })
    .eq("numero", numero)
    .select()
    .single();
  if (error) { console.error("[DB] updateNotes:", error.message); return { success: false, message: error.message }; }
  return { success: true, contact: _dbToContact(data) };
}

async function getKanbanBoard() {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("stage_updated_at", { ascending: false });
  if (error) { console.error("[DB] getKanbanBoard:", error.message); return {}; }

  const stages = {
    novo: [], tentativa_de_contato: [], conectado: [],
    conectado_com_secretario: [], consultoria_agendada: [],
    consultoria_realizada: [], no_show: [], perdido: [],
  };
  for (const row of data) {
    const c = _dbToContact(row);
    const s = c.stage || "novo";
    if (stages[s]) stages[s].push(c);
  }
  return stages;
}

// Converter row do DB para formato do app
function _dbToContact(row) {
  return {
    nome: row.nome || "",
    numero: row.numero,
    contacted: row.contacted || false,
    contactedAt: row.contacted_at ? new Date(row.contacted_at).getTime() : null,
    contactedVia: row.contacted_via || null,
    stage: row.stage || "novo",
    stageUpdatedAt: row.stage_updated_at ? new Date(row.stage_updated_at).getTime() : null,
    notes: row.notes || "",
  };
}

// ── Mensagens ──

async function saveMessage(msg) {
  const chatJid = msg.chatJid || "";
  const baseData = {
    id: msg.id,
    session_id: msg.sessionId,
    chat_jid: chatJid,
    from_me: msg.fromMe,
    push_name: msg.pushName || "",
    type: msg.type,
    body: msg.body || "",
    media_url: msg.mediaUrl || null,
    timestamp: new Date(msg.timestamp).toISOString(),
  };
  // Tentar com campos extras (is_group, participant)
  const { error } = await supabase.from("messages").upsert({
    ...baseData,
    is_group: chatJid.endsWith("@g.us"),
    participant: msg.participant || null,
  }, { onConflict: "id,session_id" });
  if (error) {
    // Fallback: salvar sem campos extras (colunas podem nao existir)
    const { error: err2 } = await supabase.from("messages").upsert(baseData, { onConflict: "id,session_id" });
    if (err2) console.error("[DB] saveMessage:", err2.message);
  }
}

async function getMessages(chatJid, limit = 500) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_jid", chatJid)
    .order("timestamp", { ascending: true })
    .limit(limit);
  if (error) { console.error("[DB] getMessages:", error.message); return []; }
  return data.map(_dbToMessage);
}

async function getChats() {
  // Buscar últimas mensagens agrupadas por chat_jid
  const { data, error } = await supabase.rpc("get_chat_list");
  if (error) {
    // Fallback: buscar manualmente se a função RPC não existir
    return await _getChatsFallback();
  }
  // Normalizar campos do RPC (chat_jid -> jid, session_id -> lastSessionId, etc.)
  return (data || []).map(row => ({
    jid: row.jid || row.chat_jid || "",
    lastMessage: row.lastMessage || row.last_message || row.body || "",
    lastTimestamp: row.lastTimestamp || (row.last_timestamp ? new Date(row.last_timestamp).getTime() : 0) || (row.timestamp ? new Date(row.timestamp).getTime() : 0),
    lastSessionId: row.lastSessionId || row.last_session_id || row.session_id || "",
    pushName: row.pushName || row.push_name || "",
    sessions: row.sessions || (row.lastSessionId ? [row.lastSessionId] : row.last_session_id ? [row.last_session_id] : []),
    isGroup: row.isGroup != null ? row.isGroup : row.is_group != null ? row.is_group : (row.jid || row.chat_jid || "").endsWith("@g.us"),
  }));
}

async function _getChatsFallback() {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .order("timestamp", { ascending: false });
  if (error) { console.error("[DB] _getChatsFallback:", error.message); return []; }

  const chatMap = new Map();
  for (const row of data) {
    const jid = row.chat_jid;
    if (!chatMap.has(jid)) {
      chatMap.set(jid, {
        jid,
        lastMessage: row.body,
        lastTimestamp: new Date(row.timestamp).getTime(),
        lastSessionId: row.session_id,
        pushName: row.push_name || jid.split("@")[0],
        sessions: [row.session_id],
        isGroup: jid.endsWith("@g.us"),
      });
    } else {
      const existing = chatMap.get(jid);
      if (!existing.sessions.includes(row.session_id)) {
        existing.sessions.push(row.session_id);
      }
    }
  }
  return Array.from(chatMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

function _dbToMessage(row) {
  const chatJid = row.chat_jid || "";
  return {
    id: row.id,
    sessionId: row.session_id,
    chatJid,
    fromMe: row.from_me,
    pushName: row.push_name || "",
    type: row.type,
    body: row.body || "",
    mediaUrl: row.media_url || null,
    timestamp: new Date(row.timestamp).getTime(),
    isGroup: row.is_group != null ? row.is_group : chatJid.endsWith("@g.us"),
    participant: row.participant || null,
  };
}

// ── Session Names ──

async function getSessionNames() {
  const { data, error } = await supabase.from("session_names").select("*");
  if (error) { console.error("[DB] getSessionNames:", error.message); return new Map(); }
  const map = new Map();
  for (const row of data) map.set(row.session_id, row.custom_name);
  return map;
}

async function saveSessionName(sessionId, customName) {
  const { error } = await supabase.from("session_names").upsert({
    session_id: sessionId,
    custom_name: customName,
    updated_at: new Date().toISOString(),
  }, { onConflict: "session_id" });
  if (error) console.error("[DB] saveSessionName:", error.message);
}

async function deleteSessionName(sessionId) {
  const { error } = await supabase.from("session_names").delete().eq("session_id", sessionId);
  if (error) console.error("[DB] deleteSessionName:", error.message);
}

// ── Migração ──

async function migrateFromFile(contacts, customNames) {
  let migrated = 0;

  // Migrar contatos
  for (const c of contacts) {
    const existing = await getContactByNumero(c.numero);
    if (!existing) {
      const { error } = await supabase.from("contacts").insert({
        nome: c.nome || "",
        numero: c.numero,
        contacted: c.contacted || false,
        contacted_at: c.contactedAt ? new Date(c.contactedAt).toISOString() : null,
        contacted_via: c.contactedVia || null,
        stage: c.stage || (c.contacted ? "tentativa_de_contato" : "novo"),
        stage_updated_at: c.stageUpdatedAt ? new Date(c.stageUpdatedAt).toISOString() : new Date().toISOString(),
        notes: c.notes || "",
      });
      if (!error) migrated++;
    }
  }

  // Migrar nomes de sessão
  for (const [sessionId, name] of customNames) {
    await saveSessionName(sessionId, name);
  }

  if (migrated > 0 || customNames.size > 0) {
    console.log(`[DB] Migração concluída: ${migrated} contatos, ${customNames.size} nomes de sessão`);
  }
}

// ── Teste de conexão ──

async function testConnection() {
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (10s)")), 10000));
    const query = supabase.from("contacts").select("count", { count: "exact", head: true });
    const { error } = await Promise.race([query, timeout]);
    if (error) throw error;
    console.log("[DB] Conectado ao Supabase com sucesso");
    return true;
  } catch (err) {
    console.error("[DB] Falha ao conectar ao Supabase:", err.message);
    return false;
  }
}

async function deleteMessages(chatJid) {
  const { error } = await supabase.from("messages").delete().eq("chat_jid", chatJid);
  if (error) { console.error("[DB] deleteMessages:", error.message); return { success: false }; }
  return { success: true };
}

module.exports = {
  supabase,
  testConnection,
  migrateFromFile,
  // Contatos
  getContacts,
  getContactByNumero,
  addContact,
  removeContact,
  markContacted,
  updateStage,
  updateNotes,
  getKanbanBoard,
  // Mensagens
  saveMessage,
  getMessages,
  getChats,
  deleteMessages,
  // Session names
  getSessionNames,
  saveSessionName,
  deleteSessionName,
};
