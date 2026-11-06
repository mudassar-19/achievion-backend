// ── Socket.IO singleton ───────────────────────────────────────────────────────
// Avoids circular imports between server.js and service modules.
// server.js calls setIo(io) after creating the Server instance.
// Other modules call getIo() when they need to emit.

let _io = null;

export function setIo(io) {
  _io = io;
}

export function getIo() {
  return _io;
}
