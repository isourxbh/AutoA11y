// Regenerate chat-transcript.md from the raw session transcript.
// Also redacts credentials/PII so the folder is safe to submit.
//
// Usage (from inside chat-history/):
//   node extract-transcript.mjs

import fs from "node:fs";

const SRC = "1791096338242_umjfy.messages.json";
const OUT = "chat-transcript.md";

let raw = fs.readFileSync(SRC, "utf8");
// Redact OAuth tokens and any email addresses.
raw = raw.replace(/workos:eyJ[a-zA-Z0-9._-]+/g, "workos:<redacted-token>");
raw = raw.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email redacted>");
fs.writeFileSync(SRC, raw);

const m = JSON.parse(raw);

const lines = [];
lines.push("# AutoA11y — Full Chat History");
lines.push("");
lines.push("> Readable conversation (prompts + replies). The raw `.messages.json`");
lines.push("> next to it also includes thinking blocks and tool calls.");
lines.push("");

const fmt = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

for (const msg of m.messages || []) {
  const texts = (msg.content || [])
    .filter((c) => c.type === "text" && c.text && c.text.trim())
    .map((c) => c.text.trim());
  if (texts.length === 0) continue;

  if (msg.role === "user") {
    const clean = texts
      .map((t) => t.replace(/<user_input[^>]*>/g, "").replace(/<\/user_input>/g, "").trim())
      .join("\n\n");
    lines.push("---");
    lines.push(`## 🧑 You · ${fmt(msg.ts)}`);
    lines.push("");
    lines.push(clean);
    lines.push("");
  } else if (msg.role === "assistant") {
    lines.push(`## 🤖 AutoA11y (Cline) · ${fmt(msg.ts)}`);
    lines.push("");
    lines.push(texts.join("\n\n"));
    lines.push("");
  }
}

fs.writeFileSync(OUT, lines.join("\n"));
console.log("wrote", OUT, fs.statSync(OUT).size, "bytes");
