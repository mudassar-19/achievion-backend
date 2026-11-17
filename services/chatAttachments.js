// F-018 (D-551): files sent in chat. Same pipeline and limits as task attachments (type by name AND first bytes, 5 MB each);
// chat allows up to 3 per message. Pure helpers; the route wiring is in routes/chatRoutes.js.
export const CHAT_MAX_FILES = 3;

// Files the upload middleware stored → what a ChatMessage keeps. A file that was not stored is not kept.
export function chatAttachmentsFrom(files) {
  return (files ?? []).filter((f) => f?.stored?.url).map((f) => ({
    url: f.stored.url,
    originalName: String(f.originalname ?? "file").replace(/[\u0000-\u001f]/g, "").slice(0, 120),
    mimeType: f.mimetype ?? "application/octet-stream",
    sizeBytes: Number(f.size) || 0,
    publicId: null,
  }));
}

// JSON and multipart both reach sendMessage; in multipart every field is a string, so `mentions` may be a JSON string.
export function readSendBody(body = {}) {
  let mentions = body.mentions ?? [];
  if (typeof mentions === "string") { try { mentions = JSON.parse(mentions); } catch { mentions = []; } }
  return { content: body.content ?? "", clientId: body.clientId, mentions: Array.isArray(mentions) ? mentions : [] };
}
