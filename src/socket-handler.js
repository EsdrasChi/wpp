module.exports = function setupSocketHandler(io, sessionManager) {
  io.on("connection", (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Enviar status inicial
    socket.emit("sessions:all", sessionManager.getStatuses());

    // Enviar chats atuais
    socket.emit("chats:list", sessionManager.getChats());

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

    socket.on("session:rename", (data) => {
      const result = sessionManager.renameSession(data.sessionId, data.customName);
      socket.emit("session:renamed", { sessionId: data.sessionId, ...result });
      // Atualizar todos os clientes
      io.emit("sessions:all", sessionManager.getStatuses());
    });

    socket.on("message:send", async (data) => {
      const { sessionId, jid, text } = data;
      const result = await sessionManager.sendText(sessionId, jid, text);
      socket.emit("message:sent", { sessionId, jid, ...result });
    });

    socket.on("chat:history", (data) => {
      const messages = sessionManager.getChatMessages(data.jid);
      socket.emit("chat:messages", { jid: data.jid, messages });
    });

    socket.on("chats:refresh", () => {
      socket.emit("chats:list", sessionManager.getChats());
    });

    socket.on("disconnect", () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });
};
