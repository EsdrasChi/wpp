const express = require("express");
const { parse } = require("csv-parse");
const fs = require("fs");
const path = require("path");

module.exports = function apiRoutes(sessionManager, upload) {
  const router = express.Router();

  // Status de todas as sessões
  router.get("/sessions", (req, res) => {
    res.json(sessionManager.getStatuses());
  });

  // Iniciar sessão
  router.post("/sessions/:id/start", async (req, res) => {
    const result = await sessionManager.startSession(req.params.id);
    res.json(result);
  });

  // Parar sessão
  router.post("/sessions/:id/stop", async (req, res) => {
    const result = await sessionManager.stopSession(req.params.id);
    res.json(result);
  });

  // Enviar texto
  router.post("/send/text", async (req, res) => {
    const { sessionId, jid, text } = req.body;
    const result = await sessionManager.sendText(sessionId, jid, text);
    res.json(result);
  });

  // Enviar imagem
  router.post("/send/image", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Nenhum arquivo enviado" });
    try {
      const { sessionId, jid, caption } = req.body;
      const result = await sessionManager.sendImage(sessionId, jid, req.file.path, caption);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Enviar áudio
  router.post("/send/audio", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Nenhum arquivo enviado" });
    try {
      const { sessionId, jid } = req.body;
      const result = await sessionManager.sendAudio(sessionId, jid, req.file.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Enviar documento
  router.post("/send/document", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Nenhum arquivo enviado" });
    try {
      const { sessionId, jid } = req.body;
      const result = await sessionManager.sendDocument(sessionId, jid, req.file.path, req.file.originalname);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Upload CSV (CRM)
  router.post("/crm/upload", upload.single("csv"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const leads = [];
    fs.createReadStream(req.file.path)
      .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
      .on("data", (row) => {
        const nome = row.nome || row.name || row.Nome || "";
        const numero = row.numero || row.number || row.Numero || row.telefone || "";
        if (numero) leads.push({ nome, numero: numero.replace(/\D/g, "") });
      })
      .on("end", () => {
        res.json({ success: true, leads, count: leads.length });
      })
      .on("error", (err) => {
        res.status(500).json({ error: err.message });
      });
  });

  // Remover instância
  router.delete("/sessions/:id", async (req, res) => {
    const result = await sessionManager.removeSession(req.params.id);
    res.json(result);
  });

  // Renomear instância
  router.post("/sessions/:id/rename", async (req, res) => {
    const { customName } = req.body;
    const result = await sessionManager.renameSession(req.params.id, customName);
    res.json(result);
  });

  // Contatos manuais
  router.get("/contacts", async (req, res) => {
    const contacts = await sessionManager.getContacts();
    res.json(contacts);
  });

  router.post("/contacts", async (req, res) => {
    const { nome, numero } = req.body;
    const result = await sessionManager.addContact(nome, numero);
    res.json(result);
  });

  router.delete("/contacts/:numero", async (req, res) => {
    const result = await sessionManager.removeContact(req.params.numero);
    res.json(result);
  });

  router.get("/contacts/pending", async (req, res) => {
    const contacts = await sessionManager.getPendingContacts();
    res.json(contacts);
  });

  router.get("/contacts/contacted", async (req, res) => {
    const contacts = await sessionManager.getContactedContacts();
    res.json(contacts);
  });

  router.post("/contacts/:numero/mark-contacted", async (req, res) => {
    const { sessionId } = req.body;
    const result = await sessionManager.markContacted(req.params.numero, sessionId);
    res.json(result);
  });

  // Kanban
  router.get("/kanban", async (req, res) => {
    const board = await sessionManager.getKanbanBoard();
    res.json(board);
  });

  router.post("/contacts/:numero/stage", async (req, res) => {
    const { stage } = req.body;
    const result = await sessionManager.updateContactStage(req.params.numero, stage);
    res.json(result);
  });

  router.post("/contacts/:numero/notes", async (req, res) => {
    const { notes } = req.body;
    const result = await sessionManager.updateContactNotes(req.params.numero, notes);
    res.json(result);
  });

  // Chats
  router.get("/chats", async (req, res) => {
    const chats = await sessionManager.getChats();
    res.json(chats);
  });

  // Mensagens de um chat
  router.get("/chats/:jid/messages", async (req, res) => {
    const msgs = await sessionManager.getChatMessages(req.params.jid);
    res.json(msgs);
  });

  return router;
};
