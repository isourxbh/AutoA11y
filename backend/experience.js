import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const LANDMARKS = new Set([
  "banner",
  "navigation",
  "main",
  "complementary",
  "contentinfo",
  "form",
  "search",
  "region",
]);

// Parse a bare node string like 'heading "Title" [level=2]' or 'img'.
function parseNodeString(str) {
  const m = str.match(/^(\S+?)(?:\s+"([\s\S]*)")?(?:\s+\[([^\]]*)\])?$/);
  if (!m) return { role: str, name: null, attrs: {} };
  const attrs = {};
  if (m[3]) {
    for (const part of m[3].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      if (eq >= 0) attrs[p.slice(0, eq).trim()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
      else attrs[p] = true;
    }
  }
  return { role: m[1], name: m[2] ?? null, attrs };
}

function buildLines(tree, filenames) {
  const lines = [];

  const emit = ({ role, name, attrs }, parentRole) => {
    if (LANDMARKS.has(role)) {
      lines.push(`${role} landmark`);
    } else if (role === "heading") {
      const lvl = attrs.level ? `, level ${attrs.level}` : "";
      lines.push(`heading${lvl}, ${name || ""}`.replace(/,\s*$/, ""));
    } else if (role === "button") {
      lines.push(name ? `button, ${name}` : "button");
    } else if (role === "link") {
      lines.push(name ? `link, ${name}` : "link");
    } else if (role === "textbox") {
      lines.push(name ? `edit text, ${name}` : "edit text");
    } else if (role === "combobox") {
      lines.push(name ? `combo box, ${name}` : "combo box");
    } else if (role === "img") {
      if (name) {
        lines.push(`image, ${name}`);
      } else if (parentRole !== "button" && parentRole !== "link") {
        // Unnamed standalone image: screen readers read the filename.
        lines.push(`image, ${filenames.shift() || "image"}`);
      }
    } else if (role === "paragraph" || role === "text") {
      if (name) lines.push(name);
    }
  };

  const walk = (node, parentRole) => {
    if (typeof node === "string") {
      emit(parseNodeString(node), parentRole);
    } else if (Array.isArray(node)) {
      for (const child of node) walk(child, parentRole);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const parsed = parseNodeString(key);
        if (Array.isArray(value)) {
          emit(parsed, parentRole);
          for (const child of value) walk(child, parsed.role);
        } else {
          emit(
            { role: parsed.role, name: parsed.name ?? value, attrs: parsed.attrs },
            parentRole
          );
        }
      }
    }
  };

  walk(tree, null);
  return lines;
}

// Produce a "browse mode" transcript the way a screen reader reads the page.
export async function screenReaderTranscript(filePath) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "load",
    });

    const snapshot = await page.locator("body").ariaSnapshot();
    const filenames = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img")).map((i) =>
        (i.getAttribute("src") || "image").split("/").pop()
      )
    );

    const tree = parseYaml(snapshot);
    return buildLines(tree, filenames);
  } finally {
    await browser.close();
  }
}

// Tab through the page and report keyboard reachability.
export async function keyboardWalk(filePath) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "load",
    });

    const unique = new Map(); // element id -> info
    let prevId = null;
    let run = 0;
    let focusTrap = false;

    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;

        // Stable per-element identity across evaluate() calls.
        if (!window.__kbCounter) window.__kbCounter = 0;
        if (el.__kbId === undefined) el.__kbId = ++window.__kbCounter;

        const cs = getComputedStyle(el);
        const tag = el.tagName;
        const role =
          el.getAttribute("role") ||
          (tag === "BUTTON"
            ? "button"
            : tag === "A"
              ? "link"
              : tag === "INPUT"
                ? ["text", "number", "date", "email", "tel"].includes(el.type)
                  ? "textbox"
                  : el.type
                : tag === "SELECT"
                  ? "combobox"
                  : tag === "TEXTAREA"
                    ? "textbox"
                    : tag.toLowerCase());
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          (el.labels && el.labels[0] && el.labels[0].textContent.trim()) ||
          (["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName)
            ? ""
            : (el.innerText || "").trim()) ||
          null;
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
        const boxShadow = cs.boxShadow && cs.boxShadow !== "none";
        // Compound inputs (date/time/etc.) expose multiple sub-tab-stops but
        // are still a single control — not a focus trap.
        const compound = ["date", "time", "month", "week", "datetime-local", "number", "range"].includes(
          el.type || ""
        );
        return { id: el.__kbId, tag, role, name, visibleFocus: outline || boxShadow, compound };
      });
      if (!info) break;

      if (!unique.has(info.id)) unique.set(info.id, info);

      if (info.id === prevId) run++;
      else run = 1;
      prevId = info.id;
      if (run >= 3 && !info.compound) {
        focusTrap = true;
        break;
      }
    }

    const stops = [...unique.values()];
    return {
      total: stops.length,
      named: stops.filter((s) => s.name).length,
      noVisibleFocus: stops.filter((s) => !s.visibleFocus).length,
      focusTrap,
      stops: stops.map((s) => ({
        role: s.role,
        name: s.name,
        visibleFocus: s.visibleFocus,
      })),
    };
  } finally {
    await browser.close();
  }
}
