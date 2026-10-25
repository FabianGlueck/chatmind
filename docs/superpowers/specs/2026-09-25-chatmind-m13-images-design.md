# chatmind M13 — Images in the composer

Date: 2026-09-25. From `feature-ideen.md` ("bild upload, screenshot einfügen"); the user asked for images in the chat input that are sent to the LLM. Builds on M3 (send), M4 (context), M8 (delete), M11 (compress), M12 (token chips).

## Decisions

| Topic | Decision |
|---|---|
| Input | The composer takes images by paste (⌘V, e.g. a screenshot), by drop onto the composer and by a 📎 button (file picker, multiple; the input stays focusable for the keyboard). Pending images show as thumbnails above the textarea, each with ✕. A message may be images only. At most `MAX_IMAGES = 6` per message. |
| Formats and size | PNG, JPEG, GIF, WebP — what every listed provider accepts. The browser scales an image whose long side exceeds 2048 px, or whose file exceeds 4 MB, down to ≤ 2048 px and re-encodes it as JPEG (0.9); the server rejects anything above `MAX_IMAGE_BYTES = 5 MB` decoded or of another type (400). |
| Transport | Inline with the send: `SendRequest.images?: { mediaType, data }[]` (base64). No separate upload — the images are written in the same lock turn as the user node, so an abandoned composer never leaves orphans, and the JSON-only CSRF guard stays as it is. |
| Storage | `<canvas>/attachments/<ULID>.<ext>`, one file per image, written once, never renamed, moved or deleted (orphans after a delete or compress stay — harmless, and the invariant "nothing else is ever deleted" holds unchanged). |
| Reference | The user node's body ends with one Obsidian embed per image, `![[<ULID>.<ext>]]`, after the typed text (blank line between). Obsidian resolves it by file name — ULIDs are unique — and shows the image; the frontmatter is untouched. Only embeds of that exact shape (a ULID plus one of the four extensions) are chatmind attachments; any other `![[…]]` stays plain text everywhere. |
| Context | `buildContext` is unchanged — embeds travel inside the message text. The server splits every user message at its attachment embeds (`splitAttachments`, core, pure) into interleaved text and image parts and loads the bytes from the canvas's `attachments/`; a missing file becomes the text `[missing image <name>]`. Assistant messages stay text. Merge blocks carry their images the same way, since they live in the one merged user message. |
| Tokens | `IMAGE_TOKENS = 1600` per embed (roughly a 1–2 MP image at any provider). `promptTokens` counts it per embed in a message; the M12 token chip uses `bodyTokens(body)` (text without embeds + images); the composer adds `IMAGE_TOKENS` per pending image. |
| Display | `MessageBody` (panel, chat view) renders attachment embeds as images from `GET /api/canvases/:slug/attachments/:name` (name must match the attachment pattern, served with its type and `cache-control: immutable`); every other image in Markdown still shows only its alt text. Cards have a fixed size, so they only carry a `🖼 n` badge in the header; a card of images only shows up to three thumbnails until the indexer has written a summary. Titles (`nodeTitle`) leave embeds out and name a body of images only `🖼 Image` / `🖼 n images`. |
| Compress (M11) | `planCompression` appends every attachment embed of the covered cards (and folds) that the model's new question and answer do not already contain to the new question, in order — images survive a compression deterministically. The compress prompt itself stays text. |
| Index | Unchanged: summaries and embeddings see the embed as text. An image-only question gets a weaker summary — accepted for now. |

## Tests

Core: `splitAttachments`, `attachmentsIn`, `bodyTokens`, `promptTokens` with embeds, `planCompression` carrying embeds. Server: send with images writes files and body, rejects wrong type/size/count, images-only send, the model receives image parts, attachment GET (type, 404, bad name). Web: composer paste adds a thumbnail, ✕ removes it, images-only send, `MessageBody` renders attachment embeds and still blocks remote images. Look and paste flow at the manual gate.
