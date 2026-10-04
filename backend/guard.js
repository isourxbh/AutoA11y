import { parse } from "node-html-parser";

// Patterns the agent is not allowed to introduce — they hide or neutralize
// content instead of actually fixing it.
const HIDING_CHECKS = [
  ["aria-hidden", (el) => el.getAttribute("aria-hidden") === "true"],
  ["role=presentation/none", (el) =>
    ["presentation", "none"].includes(el.getAttribute("role"))],
  ["display:none", (el) =>
    (el.getAttribute("style") || "").replace(/\s/g, "").includes("display:none")],
  ["visibility:hidden", (el) =>
    (el.getAttribute("style") || "").replace(/\s/g, "").includes("visibility:hidden")],
  ["tabindex=-1", (el) => el.getAttribute("tabindex") === "-1"],
];

function countTags(root) {
  const counts = {};
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

function countHiding(root) {
  const counts = {};
  for (const el of root.querySelectorAll("*")) {
    for (const [name, check] of HIDING_CHECKS) {
      if (check(el)) counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

// Collect visible text chunks, skipping <script>/<style> content.
function visibleTextChunks(root) {
  const chunks = [];
  const walk = (el) => {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const t = child.text.replace(/\s+/g, " ").trim();
        if (t) chunks.push(t);
      } else if (child.tagName) {
        const tag = child.tagName.toLowerCase();
        if (tag !== "script" && tag !== "style") walk(child);
      }
    }
  };
  walk(root);
  return chunks;
}

// Text inside labels and headings — the only visible-text additions we allow.
function labelHeadingText(root) {
  const chunks = [];
  for (const el of root.querySelectorAll("label, h1, h2, h3, h4, h5, h6")) {
    const t = el.text.replace(/\s+/g, " ").trim();
    if (t) chunks.push(t);
  }
  return chunks;
}

export function validateChange(beforeHtml, afterHtml) {
  const before = parse(beforeHtml);
  const after = parse(afterHtml);
  const reasons = [];

  // 1. Empty alt on images (marks them decorative).
  for (const img of after.querySelectorAll("img")) {
    if (img.hasAttribute("alt") && img.getAttribute("alt").trim() === "") {
      reasons.push(
        'Image has an empty alt="" (marks it decorative); use a descriptive alt instead.'
      );
    }
  }

  // 2. Elements removed (per-tag count went down).
  const beforeTags = countTags(before);
  const afterTags = countTags(after);
  for (const [tag, n] of Object.entries(beforeTags)) {
    const afterN = afterTags[tag] || 0;
    if (afterN < n) {
      reasons.push(
        `Removed ${n - afterN} <${tag}> element(s); elements must not be deleted.`
      );
    }
  }

  // 3. Hiding patterns added somewhere new.
  const beforeHide = countHiding(before);
  const afterHide = countHiding(after);
  for (const [name, n] of Object.entries(afterHide)) {
    const beforeN = beforeHide[name] || 0;
    if (n > beforeN) {
      reasons.push(
        `Added ${n - beforeN} "${name}" pattern(s); hiding content is not allowed.`
      );
    }
  }

  // 4. Visible text changes beyond added labels/headings.
  const beforeText = visibleTextChunks(before);
  const afterText = visibleTextChunks(after);
  const afterJoined = afterText.join(" ");
  for (const chunk of beforeText) {
    if (!afterJoined.includes(chunk)) {
      reasons.push(`Visible text was removed or modified: "${chunk}".`);
      break;
    }
  }
  const beforeJoined = beforeText.join(" ");
  const allowed = labelHeadingText(after);
  for (const chunk of afterText) {
    const isNew = !beforeJoined.includes(chunk);
    const isAllowed = allowed.some(
      (a) => a.includes(chunk) || chunk.includes(a)
    );
    if (isNew && !isAllowed) {
      reasons.push(
        `Visible text was added outside of a label/heading: "${chunk}".`
      );
      break;
    }
  }

  return { ok: reasons.length === 0, reasons };
}
