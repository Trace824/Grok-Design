import type { DesignSystem, Project } from "./types";
import { tweaksToVars, applyCssVars } from "./iframe-bridge";

export function projectHtml(project: Project): string {
  return applyCssVars(project.html, tweaksToVars(project.tweaks));
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadHtml(project: Project) {
  const html = projectHtml(project);
  downloadBlob(
    `${slug(project.name)}.html`,
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
}

export async function downloadZip(project: Project, system?: DesignSystem) {
  const html = projectHtml(project);
  const readme = [
    `# ${project.name}`,
    ``,
    `Kind: ${project.kind} · ${project.fidelity}`,
    system ? `Design system: ${system.name}` : "",
    ``,
    `Open index.html in a browser.`,
    `Handoff: paste HAND-OFF.md into Grok Code.`,
  ]
    .filter(Boolean)
    .join("\n");
  const handoff = handoffMarkdown(project, system);
  const files: Record<string, string> = {
    "index.html": html,
    "README.md": readme,
    "HAND-OFF.md": handoff,
    "tokens.json": JSON.stringify(
      {
        tweaks: project.tweaks,
        system: system ?? null,
      },
      null,
      2,
    ),
  };
  const blob = await buildZip(files);
  downloadBlob(`${slug(project.name)}.zip`, blob);
}

export function printPdf() {
  const frame = document.querySelector<HTMLIFrameElement>("[data-gd-frame]");
  frame?.contentWindow?.focus();
  frame?.contentWindow?.print();
}

export function downloadPptx(project: Project) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escape(project.name)}</title>
<style>
  @page { size: 13.33in 7.5in; margin: 0; }
  html, body { margin: 0; }
  iframe { border: 0; width: 100vw; height: 100vh; }
</style></head>
<body>${projectHtml(project)}</body></html>`;
  downloadBlob(
    `${slug(project.name)}-slides.html`,
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
}

export function handoffMarkdown(project: Project, system?: DesignSystem): string {
  return [
    `# Handoff · ${project.name}`,
    ``,
    `Implement this design as production software.`,
    ``,
    `## Intent`,
    `- Kind: ${project.kind}`,
    `- Fidelity: ${project.fidelity}`,
    system ? `- Design system: ${system.name}` : "",
    system ? `- Tokens: ${system.colors.map((c) => `${c.name} ${c.value}`).join(", ")}` : "",
    ``,
    `## Tweaks currently applied`,
    ...project.tweaks.map((t) => `- ${t.label}: ${t.value}${t.unit ?? ""} (${t.cssVar})`),
    ``,
    `## HTML source`,
    ``,
    "```html",
    projectHtml(project),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function downloadHandoff(project: Project, system?: DesignSystem) {
  downloadBlob(
    `${slug(project.name)}-handoff.md`,
    new Blob([handoffMarkdown(project, system)], { type: "text/markdown;charset=utf-8" }),
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "design";
}

function escape(s: string) {
  const amp = String.fromCharCode(38);
  return s
    .replace(/&/g, amp + "amp;")
    .replace(/</g, amp + "lt;")
    .replace(/>/g, amp + "gt;");
}

async function buildZip(files: Record<string, string>): Promise<Blob> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const now = dosTime(new Date());

  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content);
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, now.time, true);
    lv.setUint16(12, now.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    chunks.push(local, data);

    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, now.time, true);
    cv.setUint16(14, now.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Object.keys(files).length, true);
  ev.setUint16(10, Object.keys(files).length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const blobParts: BlobPart[] = [
    ...chunks.map((u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer),
    ...centrals.map((u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer),
    end.buffer.slice(end.byteOffset, end.byteOffset + end.byteLength) as ArrayBuffer,
  ];
  return new Blob(blobParts, { type: "application/zip" });
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
