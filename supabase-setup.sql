-- =============================================
-- WPP OUTBOUND — Supabase Database Setup
-- Execute este script no SQL Editor do Supabase
-- (Painel > SQL Editor > New Query > Colar > Run)
-- =============================================

-- Tabela de contatos/leads
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT '',
  numero TEXT NOT NULL UNIQUE,
  contacted BOOLEAN DEFAULT FALSE,
  contacted_at TIMESTAMPTZ,
  contacted_via TEXT,
  stage TEXT DEFAULT 'novo',
  stage_updated_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_numero ON contacts(numero);

-- Tabela de mensagens
CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  from_me BOOLEAN DEFAULT FALSE,
  push_name TEXT DEFAULT '',
  type TEXT DEFAULT 'text',
  body TEXT DEFAULT '',
  media_url TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid);
CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);

-- Tabela de nomes customizados das instancias
CREATE TABLE IF NOT EXISTS session_names (
  session_id TEXT PRIMARY KEY,
  custom_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Desabilitar RLS para acesso via service_role key
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_names ENABLE ROW LEVEL SECURITY;

-- Policies para permitir acesso total via service_role
CREATE POLICY "service_role_contacts" ON contacts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_messages" ON messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_session_names" ON session_names FOR ALL USING (true) WITH CHECK (true);
