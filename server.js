const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");

const SessionManager = require("./src/session-manager");
const setupSocketHandler = require("./src/socket-handler");
const apiRoutes = require("./src/routes/api");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ── Middleware ──
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Upload config ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ── Session Manager (singleton) ──
const sessionManager = new SessionManager(io);

// ── Routes ──
app.use("/api", apiRoutes(sessionManager, upload));

// ── SPA fallback ──
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Socket.io ──
setupSocketHandler(io, sessionManager);

// ── Start ──
server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   WPP OUTBOUND running on port ${PORT}   ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled:", err.message);
});
