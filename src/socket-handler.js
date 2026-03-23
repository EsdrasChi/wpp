module.exports = function setupSocketHandler(io, sessionManager) {
  io.on("connection", async (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Enviar status inicial
    socket.emit("sessions:all", sessionManager.getStatuses());

    // Enviar chats atuais
    const chats = await sessionManager.getChats();
    socket.emit("chats:list", chats);

    socket.on("session:start", async (data) => {
      const result = await sessionManager.startSession(data.sessionId);
      socket.emit("session:result", { sessionId: data.sessionId, ...result });
    });

    socket.on("session:stop", async (data) => {
      const result = await sessionManager.stopSession(data.sessionId);
      socket.emit("session:result", { sessionId: data.sessionId, ...result });
    });

    socket.on("session:remove", async (data) => {
      const result = await sessionManager.removeSession(data.sessionId);
      socket.emit("session:result", { sessionId: data.sessionId, ...result });
      io.emit("sessions:all", sessionManager.getStatuses());
    });

    socket.on("session:rename", async (data) => {
      const result = await sessionManager.renameSession(data.sessionId, data.customName);
      socket.emit("session:renamed", { sessionId: data.sessionId, ...result });
      io.emit("sessions:all", sessionManager.getStatuses());
    });

    socket.on("message:send", async (data) => {
      const { sessionId, jid, text } = data;
      const result = await sessionManager.sendText(sessionId, jid, text);
      socket.emit("message:sent", { sessionId, jid, ...result });
    });

    socket.on("chat:history", async (data) => {
      const messages = await sessionManager.getChatMessages(data.jid);
      socket.emit("chat:messages", { jid: data.jid, messages });
    });

    socket.on("contact:update-stage", async (data) => {
      const { numero, stage } = data;
      const result = await sessionManager.updateContactStage(numero, stage);
      if (result.success) {
        io.emit("kanban:stage-changed", { numero, stage, contact: result.contact });
      }
    });

    socket.on("chats:refresh", async () => {
      const refreshedChats = await sessionManager.getChats();
      socket.emit("chats:list", refreshedChats);
    });

    socket.on("chat:clear", async (data) => {
      const result = await sessionManager.clearChat(data.jid);
      if (result.success) {
        io.emit("chat:cleared", { jid: data.jid });
      }
    });

    socket.on("group:info", async (data) => {
      if (!data || !data.jid || !String(data.jid).endsWith("@g.us")) return;
      try {
        const info = await sessionManager.getGroupInfo(data.jid);
        socket.emit("group:info", info || {
          jid: data.jid, announce: false, isAdmin: false, participants: [],
        });
      } catch (err) {
        console.error("[WS] group:info error:", err.message);
        socket.emit("group:info", {
          jid: data.jid, announce: false, isAdmin: false, participants: [],
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });
};
