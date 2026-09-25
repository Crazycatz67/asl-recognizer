// tools/mobile-audit.js — drives tools/mobile-audit.html (dev-only, never
// loaded by the app). Phone-size layout checks for every screen.
//
// Owner (2026-09-25): the app is mostly tested on a MacBook but must "fit
// appropriately and everything be clear, legible and easy in mobile
// formatting". This makes that checkable and repeatable after every change.

const SIZES = [
  { name: "360x800", w: 360, h: 800 },
  { name: "390x844", w: 390, h: 844 },
  { name: "412x915", w: 412, h: 915 },
  { name: "844x390 landscape", w: 844, h: 390 },
];
const MIN_TAP = 44;
const MIN_TEXT = 13;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (d, sel) => { const el = d.querySelector(sel); el?.click(); return !!el; };

// each screen: steps run inside the iframe's document before auditing
const SCREENS = [
  { name: "Home", steps: async (d) => { click(d, "#homeBtn"); await sleep(700); }, after: async (d) => { click(d, "#heroStart"); await sleep(400); closeTour(d); } },
  { name: "Practice", steps: async (d) => { click(d, '[data-mode="practice"]'); await sleep(200); click(d, '[data-sub="free"]'); await sleep(200); d.querySelector("#letterPicker button.chip")?.click(); await sleep(500); } },
  { name: "A→Z run", steps: async (d) => { click(d, '[data-sub="az"]'); await sleep(500); }, after: async (d) => { click(d, '[data-sub="free"]'); } },
  { name: "Challenge", steps: async (d) => { click(d, '[data-mode="challenge"]'); await sleep(500); } },
  { name: "Spell", steps: async (d) => { click(d, '[data-mode="spell"]'); await sleep(500); } },
  { name: "Read", steps: async (d) => { click(d, '[data-mode="read"]'); await sleep(600); } },
  { name: "Progress: letters", steps: async (d) => { click(d, '[data-mode="practice"]'); click(d, "#progressBtn"); await sleep(400); } },
  { name: "Progress: achievements", steps: async (d) => { click(d, '#pgTabs [data-tab="ach"]'); await sleep(300); } },
  { name: "Progress: records", steps: async (d) => { click(d, '#pgTabs [data-tab="records"]'); await sleep(300); }, after: async (d) => { click(d, "#progressClose"); await sleep(200); } },
  { name: "Tour", steps: async (d) => { click(d, "#tourBtn"); await sleep(600); }, after: async (d) => { closeTour(d); } },
];
function closeTour(d) {
  [...d.querySelectorAll("button")].find((b) => /skip tour/i.test(b.textContent) && b.offsetParent)?.click();
}

const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"], [role="radio"], [role="button"], summary';

function describe(el) {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const txt = (el.getAttribute("aria-label") || el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 28);
  return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` “${txt}”` : ""}`;
}
function visible(el, win) {
  if (el.closest("[hidden], [inert]")) return false;
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = win.getComputedStyle(el);
  return cs.visibility !== "hidden" && +cs.opacity > 0.05 && cs.pointerEvents !== "none";
}
function scrollableAncestor(el, win) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = win.getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

function auditDoc(win, W, H) {
  const d = win.document;
  const issues = { overflow: [], cutOff: [], unreachable: [], smallTap: [], smallText: [], covered: [] };
  if (d.documentElement.scrollWidth > W + 1) issues.overflow.push(`page is ${d.documentElement.scrollWidth}px wide (> ${W})`);
  const els = [...d.querySelectorAll(INTERACTIVE)].filter((el) => visible(el, win));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > W + 1) issues.cutOff.push(`${describe(el)} x ${Math.round(r.left)}..${Math.round(r.right)}`);
    else if ((r.top > H - 4 || r.bottom < 4) && !scrollableAncestor(el, win)) issues.unreachable.push(`${describe(el)} y ${Math.round(r.top)}`);
    // tap target (inline text links inside paragraphs are exempt)
    const inlineLink = el.tagName === "A" && win.getComputedStyle(el).display === "inline";
    if (!inlineLink && (r.width < MIN_TAP - 0.5 || r.height < MIN_TAP - 0.5)) issues.smallTap.push(`${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    // covered: the centre point hits something unrelated
    const cx = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    if (cy >= 0 && cy < H) {
      const hit = d.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el.htmlFor && hit.id === el.htmlFor)) issues.covered.push(`${describe(el)} under ${describe(hit)}`);
    }
  }
  // readable text below MIN_TEXT px (skip aria-hidden decoration + empty)
  const seen = new Set();
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim() || el.closest('[aria-hidden="true"], script, style')) continue;
    seen.add(el);
    if (!visible(el, win)) continue;
    const fs = parseFloat(win.getComputedStyle(el).fontSize);
    if (fs < MIN_TEXT - 0.2) issues.smallText.push(`${describe(el)} ${fs.toFixed(1)}px`);
  }
  for (const k in issues) issues[k] = [...new Set(issues[k])];
  return issues;
}

async function loadFrame(size, host) {
  const fig = document.createElement("figure");
  const f = document.createElement("iframe");
  f.width = size.w; f.height = size.h;
  f.src = `../index.html?audit=${Date.now()}`;
  const cap = document.createElement("figcaption");
  cap.textContent = size.name;
  fig.append(f, cap);
  host.appendChild(fig);
  await new Promise((r) => f.addEventListener("load", r, { once: true }));
  await sleep(1500); // modules + dataset
  const d = f.contentDocument;
  // start as a returning user with the landing page closed
  d.querySelector("#heroStart")?.click();
  await sleep(300);
  closeTour(d);
  await sleep(200);
  return f;
}

async function run() {
  const status = document.getElementById("status");
  const out = document.getElementById("out");
  const frames = document.getElementById("frames");
  frames.innerHTML = ""; out.innerHTML = "";
  try { localStorage.setItem("asl-pref-seen-intro", "1"); } catch {}
  const results = [];
  for (const size of SIZES) {
    status.textContent = `loading ${size.name}…`;
    const f = await loadFrame(size, frames);
    for (const sc of SCREENS) {
      status.textContent = `${size.name} · ${sc.name}`;
      try { await sc.steps(f.contentDocument); } catch (e) { results.push({ size: size.name, screen: sc.name, error: String(e) }); continue; }
      const issues = auditDoc(f.contentWindow, size.w, size.h);
      results.push({ size: size.name, screen: sc.name, issues });
      try { await sc.after?.(f.contentDocument); } catch {}
    }
  }
  window.__audit = results;
  render(results, out);
  status.textContent = "done";
}

function render(results, out) {
  const kinds = ["overflow", "cutOff", "unreachable", "smallTap", "smallText", "covered"];
  let html = `<table><tr><th>size</th><th>screen</th>${kinds.map((k) => `<th>${k}</th>`).join("")}</tr>`;
  for (const r of results) {
    html += `<tr><td>${r.size}</td><td>${r.screen}</td>`;
    if (r.error) { html += `<td colspan="${kinds.length}" class="bad">${r.error}</td></tr>`; continue; }
    for (const k of kinds) {
      const list = r.issues[k];
      html += list.length
        ? `<td class="bad"><details><summary>${list.length}</summary>${list.map((x) => `<div>${x.replace(/</g, "&lt;")}</div>`).join("")}</details></td>`
        : `<td class="ok">0</td>`;
    }
    html += "</tr>";
  }
  out.innerHTML = html + "</table>";
}

document.getElementById("run").addEventListener("click", run);
if (new URLSearchParams(location.search).has("auto")) run();
