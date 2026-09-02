export const IFRAME_BRIDGE = `
<script>
(() => {
  const MODE_KEY = "__grokMode";
  window[MODE_KEY] = "preview";
  let selected = null;
  function post(payload) {
    try { parent.postMessage({ source: "grok-design", ...payload }, "*"); } catch {}
  }
  function clearSel() {
    if (selected) selected.style.outline = selected.dataset._prevOutline || "";
    selected = null;
  }
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.source !== "grok-design-host") return;
    if (d.type === "set-mode") {
      window[MODE_KEY] = d.mode;
      document.documentElement.dataset.gdMode = d.mode;
      if (d.mode !== "edit") clearSel();
    }
    if (d.type === "set-vars" && d.vars) {
      const root = document.documentElement;
      Object.entries(d.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    }
    if (d.type === "set-text" && d.selector && typeof d.text === "string") {
      const el = document.querySelector(d.selector);
      if (el) el.textContent = d.text;
    }
    if (d.type === "apply-style" && d.selector && d.style) {
      const el = document.querySelector(d.selector);
      if (el) Object.assign(el.style, d.style);
    }
  });
  document.addEventListener("click", (ev) => {
    const mode = window[MODE_KEY];
    if (mode === "preview") return;
    const el = ev.target;
    if (!(el instanceof Element)) return;
    if (el.closest("[data-gd-ignore]")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = el.getBoundingClientRect();
    const path = cssPath(el);
    if (mode === "edit") {
      clearSel();
      selected = el;
      el.dataset._prevOutline = el.style.outline;
      el.style.outline = "2px solid #2563eb";
      el.contentEditable = "true";
      el.focus();
    }
    post({
      type: "element",
      mode,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || "").slice(0, 160),
      selector: path,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    });
  }, true);
  document.addEventListener("input", (ev) => {
    if (window[MODE_KEY] !== "edit") return;
    const el = ev.target;
    if (!(el instanceof Element)) return;
    post({ type: "text-edit", selector: cssPath(el), text: el.textContent || "" });
  }, true);
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let sel = el.nodeName.toLowerCase();
      if (el.classList && el.classList.length) {
        sel += "." + [...el.classList].slice(0, 2).map((c) => CSS.escape(c)).join(".");
      }
      const parent = el.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.nodeName === el.nodeName);
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  post({ type: "ready" });
})();
</script>
`;

export function injectBridge(html: string): string {
  if (!html) return html;
  if (html.includes("source: \"grok-design\"")) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${IFRAME_BRIDGE}</body>`);
  return html + IFRAME_BRIDGE;
}

export function applyCssVars(html: string, vars: Record<string, string>): string {
  if (!html || !Object.keys(vars).length) return html;
  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  const tag = `<style id="gd-live-vars">:root { ${decls} }</style>`;
  if (html.includes('id="gd-live-vars"')) {
    return html.replace(
      /<style id="gd-live-vars">[\s\S]*?<\/style>/,
      tag,
    );
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  return tag + html;
}

export function tweaksToVars(
  tweaks: { cssVar: string; value: string; unit?: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tweaks) {
    const needsUnit =
      t.unit && t.value && !String(t.value).endsWith(t.unit) && t.value !== "true" && t.value !== "false";
    out[t.cssVar] = needsUnit ? `${t.value}${t.unit}` : t.value;
  }
  return out;
}
