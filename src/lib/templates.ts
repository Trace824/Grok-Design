import type { DesignSystem, Fidelity, ProjectKind, Tweak } from "./types";

export type GeneratedDesign = {
  reply: string;
  title: string;
  html: string;
  tweaks: Tweak[];
};

const DEFAULT_TWEAKS: Tweak[] = [
  { id: "accent", label: "Accent", type: "color", cssVar: "--accent", value: "#1c1917" },
  { id: "bg", label: "Background", type: "color", cssVar: "--bg", value: "#f6f4ef" },
  { id: "ink", label: "Ink", type: "color", cssVar: "--ink", value: "#161513" },
  {
    id: "radius",
    label: "Corner radius",
    type: "range",
    cssVar: "--radius",
    value: "14",
    min: 0,
    max: 36,
    step: 1,
    unit: "px",
  },
  {
    id: "pad",
    label: "Section padding",
    type: "range",
    cssVar: "--pad",
    value: "72",
    min: 32,
    max: 120,
    step: 4,
    unit: "px",
  },
  {
    id: "theme",
    label: "Theme",
    type: "select",
    cssVar: "--theme",
    value: "light",
    options: [
      { label: "Light", value: "light" },
      { label: "Dark", value: "dark" },
    ],
  },
];

function sysColors(sys?: DesignSystem) {
  const get = (n: string, fb: string) =>
    sys?.colors.find((c) => c.name.toLowerCase().includes(n.toLowerCase()))?.value ?? fb;
  return {
    ink: get("ink", get("primary", "#161513")),
    paper: get("paper", get("background", "#f6f4ef")),
    accent: get("accent", "#1c1917"),
    stone: get("stone", "#8a847c"),
    highlight: get("highlight", "#d9c7a8"),
  };
}

function wrap(title: string, body: string, colors: ReturnType<typeof sysColors>, extra = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet"/>
<style>
  :root {
    --ink: ${colors.ink};
    --bg: ${colors.paper};
    --accent: ${colors.accent};
    --stone: ${colors.stone};
    --highlight: ${colors.highlight};
    --radius: 14px;
    --pad: 72px;
    --line: color-mix(in oklab, var(--ink) 10%, transparent);
    --mute: color-mix(in oklab, var(--ink) 58%, var(--bg));
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: Figtree, system-ui, sans-serif; }
  body { min-height: 100vh; }
  h1, h2, h3, .serif { font-family: Newsreader, Georgia, serif; font-weight: 500; letter-spacing: -0.03em; }
  a { color: inherit; }
  button { font: inherit; }
  img { max-width: 100%; }
  ${extra}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string) {
  const amp = String.fromCharCode(38);
  return s
    .replace(/&/g, amp + "amp;")
    .replace(/</g, amp + "lt;")
    .replace(/>/g, amp + "gt;")
    .replace(/"/g, amp + "quot;")
    .replace(/'/g, amp + "#39;");
}

export function fallbackDesign(opts: {
  prompt: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  speakerNotes?: boolean;
  system?: DesignSystem;
}): GeneratedDesign {
  const title = inferTitle(opts.prompt);
  const colors = sysColors(opts.system);
  if (/slide|deck|pitch|presentation/i.test(opts.prompt) || opts.kind === "slides") {
    return {
      reply: `First pass on a ${opts.speakerNotes ? "speaker-notes " : ""}deck for “${title}”. Use Present or the arrows to walk the slides, then comment on any card.`,
      title,
      html: slideDeck(title, opts.prompt, colors, opts.fidelity, opts.speakerNotes),
      tweaks: DEFAULT_TWEAKS,
    };
  }
  if (opts.fidelity === "wireframe") {
    return {
      reply: `A structural wireframe for “${title}”. Gray boxes keep the conversation on flow — switch to high fidelity when the bones are right.`,
      title,
      html: wireframePage(title, opts.prompt, colors),
      tweaks: DEFAULT_TWEAKS.filter((t) => t.id !== "accent"),
    };
  }
  if (/dash|metric|analytics|admin|revenue desk/i.test(opts.prompt)) {
    return {
      reply: `A working dashboard for “${title}”. Filters and cards are live — tweak density and accent from the Tweaks panel.`,
      title,
      html: dashboardPage(title, opts.prompt, colors),
      tweaks: DEFAULT_TWEAKS,
    };
  }
  if (/\b(mobile|ios|android|onboarding)\b/i.test(opts.prompt) && !/landing|marketing|website|site/i.test(opts.prompt)) {
    return {
      reply: `A four-screen mobile flow for “${title}”. Click through the phones — comments pin to a specific screen.`,
      title,
      html: mobileFlow(title, opts.prompt, colors),
      tweaks: DEFAULT_TWEAKS,
    };
  }
  return {
    reply: `A first version of “${title}”. Edit copy in place, leave inline comments, or ask for a different direction in chat.`,
    title,
    html: landingPage(title, opts.prompt, colors),
    tweaks: DEFAULT_TWEAKS,
  };
}

export function inferTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled design";
  const called = cleaned.match(/\b(?:called|named)\s+[“"']?([A-Za-z][\w-]*)/);
  if (called) return called[1];
  const quoted = cleaned.match(/[“"]([^”"]+)[”"]/);
  if (quoted) return quoted[1].slice(0, 48);
  const words = cleaned
    .replace(/^(create|design|build|make|prototype|draft)\s+(a|an|the)?\s*/i, "")
    .split(" ")
    .slice(0, 6)
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1, 52);
}

function landingPage(title: string, prompt: string, c: ReturnType<typeof sysColors>) {
  const lede = prompt.replace(/\s+/g, " ").trim().slice(0, 220);
  const body = `
<header style="display:flex;justify-content:space-between;align-items:center;padding:22px 40px;border-bottom:1px solid var(--line)">
  <div class="serif" style="font-size:22px">${escapeHtml(title)}</div>
  <nav style="display:flex;gap:22px;font-size:14px;color:var(--mute)">
    <a href="#product">Product</a><a href="#work">Practice</a><a href="#pricing">Pricing</a>
  </nav>
  <button style="background:var(--accent);color:var(--bg);border:0;border-radius:999px;padding:10px 16px;font-weight:600">Get access</button>
</header>
<section style="padding: var(--pad) 40px 48px; max-width: 1120px; margin: 0 auto; display:grid; grid-template-columns: 1.1fr .9fr; gap: 56px; align-items:center">
  <div>
    <p style="letter-spacing:.16em;text-transform:uppercase;font-size:11px;color:var(--mute);margin:0 0 16px">New · Research preview</p>
    <h1 style="font-size: clamp(42px, 6vw, 72px); line-height: .95; margin: 0 0 20px">${escapeHtml(title)}</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--mute);max-width:34em;margin:0 0 28px">${escapeHtml(lede)}</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <button style="background:var(--accent);color:var(--bg);border:0;border-radius:999px;padding:12px 18px;font-weight:600">Start a session</button>
      <button style="background:transparent;border:1px solid var(--line);border-radius:999px;padding:12px 18px">See the practice</button>
    </div>
  </div>
  <div style="background: color-mix(in oklab, var(--highlight) 55%, var(--bg)); border:1px solid var(--line); border-radius: calc(var(--radius) + 8px); min-height: 380px; padding: 28px; display:grid; gap:14px">
    <div style="font-family:Newsreader,serif;font-size:28px;line-height:1.1">Sit for ten minutes.<br/>Leave the rest.</div>
    <div style="height:1px;background:var(--line);margin:8px 0"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:auto">
      <div style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)"><div style="font-size:11px;color:var(--mute)">Today</div><div style="font-size:22px;font-family:Newsreader,serif">12m</div></div>
      <div style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)"><div style="font-size:11px;color:var(--mute)">Streak</div><div style="font-size:22px;font-family:Newsreader,serif">9</div></div>
      <div style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)"><div style="font-size:11px;color:var(--mute)">Quiet</div><div style="font-size:22px;font-family:Newsreader,serif">On</div></div>
    </div>
  </div>
</section>
<section id="product" style="padding: 8px 40px 80px; max-width: 1120px; margin: 0 auto; display:grid; grid-template-columns: repeat(3,1fr); gap: 16px">
  ${["A single sitting", "Nothing to unlock", "Yours, not ours"]
    .map(
      (h, i) => `
    <article style="background: var(--bg); border:1px solid var(--line); border-radius: var(--radius); padding: 22px 22px 26px">
      <div style="font-size:12px;color:var(--mute);margin-bottom:18px">0${i + 1}</div>
      <h3 style="margin:0 0 8px;font-size:24px">${h}</h3>
      <p style="margin:0;color:var(--mute);line-height:1.5">No streaks-as-guilt. A timer, a room tone, and a way to come back tomorrow if you want.</p>
    </article>`,
    )
    .join("")}
</section>`;
  return wrap(title, body, c, `@media (max-width: 800px) { section { grid-template-columns: 1fr !important; } }`);
}

function dashboardPage(title: string, prompt: string, c: ReturnType<typeof sysColors>) {
  const body = `
<div style="display:grid;grid-template-columns:220px 1fr;min-height:100vh">
  <aside style="border-right:1px solid var(--line);padding:22px 16px">
    <div class="serif" style="font-size:20px;padding:0 8px 22px">${escapeHtml(title)}</div>
    ${["Overview", "Revenue", "Customers", "Reports", "Settings"]
      .map(
        (l, i) =>
          `<div style="padding:10px 12px;border-radius:10px;margin-bottom:4px;background:${i === 0 ? "color-mix(in oklab, var(--ink) 6%, var(--bg))" : "transparent"};font-size:14px">${l}</div>`,
      )
      .join("")}
  </aside>
  <main style="padding:28px 32px 48px">
    <div style="display:flex;justify-content:space-between;align-items:end;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:34px">Monthly revenue</h1>
        <p style="margin:6px 0 0;color:var(--mute)">${escapeHtml(prompt.slice(0, 120))}</p>
      </div>
      <div style="display:flex;gap:8px">
        <select style="border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:8px 10px"><option>All regions</option><option>NA</option><option>EU</option></select>
        <select style="border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:8px 10px"><option>All products</option></select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
      ${[
        ["Revenue", "$428k", "+12%"],
        ["Active", "12,480", "+4%"],
        ["NRR", "118%", "+2pts"],
        ["Churn", "2.1%", "−0.3"],
      ]
        .map(
          ([k, v, d]) =>
            `<div style="border:1px solid var(--line);border-radius:var(--radius);padding:16px 16px 18px"><div style="font-size:12px;color:var(--mute)">${k}</div><div style="font-size:28px;font-family:Newsreader,serif;margin-top:8px">${v}</div><div style="font-size:12px;margin-top:6px">${d}</div></div>`,
        )
        .join("")}
    </div>
    <div style="border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px 8px;min-height:280px">
      <div style="font-size:13px;color:var(--mute);margin-bottom:18px">Trailing twelve months</div>
      <svg viewBox="0 0 640 180" width="100%" height="180">
        <polyline fill="none" stroke="var(--ink)" stroke-width="2" points="0,140 60,120 120,128 180,90 240,100 300,70 360,78 420,48 480,60 540,36 640,44"/>
      </svg>
    </div>
  </main>
</div>`;
  return wrap(title, body, c);
}

function mobileFlow(title: string, prompt: string, c: ReturnType<typeof sysColors>) {
  const screens = [
    { k: "Welcome", h: title, p: "A quieter way to begin." },
    { k: "Intent", h: "What do you need?", p: "Pick a lane. You can change it later." },
    { k: "Permission", h: "Stay in the loop", p: "Only the signals that matter." },
    { k: "Ready", h: "You’re in", p: prompt.slice(0, 90) },
  ];
  const body = `
<div style="padding:48px 32px 80px;display:flex;gap:28px;justify-content:center;align-items:flex-start;flex-wrap:wrap">
  ${screens
    .map(
      (s, i) => `
    <div style="width:260px">
      <div style="font-size:12px;color:var(--mute);margin-bottom:8px">0${i + 1} · ${s.k}</div>
      <div style="background:#111;border-radius:36px;padding:12px;box-shadow:0 20px 50px rgb(0 0 0 / .18)">
        <div style="background:var(--bg);border-radius:26px;min-height:480px;padding:28px 20px;display:flex;flex-direction:column">
          <div style="height:6px;width:48px;background:var(--ink);border-radius:99px;margin:0 auto 28px;opacity:.2"></div>
          <h2 style="font-size:30px;line-height:1.05;margin:0 0 12px">${escapeHtml(s.h)}</h2>
          <p style="color:var(--mute);margin:0 0 20px;line-height:1.45">${escapeHtml(s.p)}</p>
          <div style="margin-top:auto">
            <button style="width:100%;background:var(--accent);color:var(--bg);border:0;border-radius:999px;padding:12px;font-weight:600">${i === 3 ? "Open app" : "Continue"}</button>
          </div>
        </div>
      </div>
    </div>`,
    )
    .join("")}
</div>`;
  return wrap(title, body, c);
}

function wireframePage(title: string, prompt: string, c: ReturnType<typeof sysColors>) {
  const body = `
<div style="padding:28px;max-width:1100px;margin:0 auto;font-family:ui-monospace,monospace">
  <div style="display:flex;justify-content:space-between;border:1.5px dashed #888;padding:12px 16px;margin-bottom:16px">
    <span>[ logo ] ${escapeHtml(title)}</span>
    <span>nav · nav · nav · [ CTA ]</span>
  </div>
  <div style="display:grid;grid-template-columns:1.2fr .8fr;gap:16px;margin-bottom:16px">
    <div style="border:1.5px dashed #888;min-height:280px;padding:24px">
      <div style="height:18px;width:70%;background:#bbb;margin-bottom:12px"></div>
      <div style="height:18px;width:50%;background:#ccc;margin-bottom:20px"></div>
      <div style="height:10px;width:90%;background:#ddd;margin-bottom:8px"></div>
      <div style="height:10px;width:80%;background:#ddd;margin-bottom:20px"></div>
      <div style="display:inline-block;border:1.5px solid #666;padding:8px 16px">Primary</div>
      <p style="color:#777;font-size:12px;margin-top:24px">${escapeHtml(prompt.slice(0, 180))}</p>
    </div>
    <div style="border:1.5px dashed #888;min-height:280px;display:grid;place-items:center;color:#999">HERO / MEDIA</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
    ${["A", "B", "C"]
      .map(
        (x) =>
          `<div style="border:1.5px dashed #888;min-height:140px;padding:16px"><div style="height:10px;width:40%;background:#ccc;margin-bottom:10px"></div>Block ${x}</div>`,
      )
      .join("")}
  </div>
</div>`;
  return wrap(title + " · wireframe", body, c);
}

function slideDeck(
  title: string,
  prompt: string,
  c: ReturnType<typeof sysColors>,
  fidelity: Fidelity,
  notes?: boolean,
) {
  const slides = [
    { k: "Title", h: title, p: prompt.slice(0, 140) },
    { k: "Problem", h: "The work is stuck in files", p: "Briefs, decks, and mocks live in different tools. Ideas stall before anyone can react." },
    { k: "Shift", h: "Design in the conversation", p: "Describe the artifact. Refine on the canvas. Export when it’s time to leave." },
    { k: "System", h: "Brand, applied automatically", p: "One published system. Every prototype, deck, and one-pager inherits it." },
    { k: "Close", h: "Start with a sentence", p: "Grok Design turns the first description into something you can point at." },
  ];
  const extra = `
    .deck { height: 100vh; overflow: hidden; position: relative; }
    .slide { position: absolute; inset: 0; padding: 72px 80px; display: none; }
    .slide.on { display: flex; flex-direction: column; justify-content: center; }
    .kicker { letter-spacing: .18em; text-transform: uppercase; font-size: 12px; color: var(--mute); margin-bottom: 18px; }
    h1 { font-size: clamp(40px, 6vw, 72px); margin: 0 0 16px; line-height: .98; }
    .lede { font-size: 22px; color: var(--mute); max-width: 22em; line-height: 1.4; }
    .nav { position: fixed; bottom: 24px; right: 28px; display: flex; gap: 8px; z-index: 2; }
    .nav button { border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 8px 12px; }
    .notes { position: fixed; left: 28px; bottom: 24px; font-size: 12px; color: var(--mute); max-width: 36em; }
    .wf { outline: 1.5px dashed #999; }
  `;
  const body = `
<div class="deck">
  ${slides
    .map(
      (s, i) => `
    <section class="slide${i === 0 ? " on" : ""}${fidelity === "wireframe" ? " wf" : ""}" data-slide="${i}">
      <div class="kicker">${escapeHtml(s.k)}</div>
      <h1>${escapeHtml(s.h)}</h1>
      <p class="lede">${escapeHtml(s.p)}</p>
    </section>`,
    )
    .join("")}
  <div class="nav" data-gd-ignore>
    <button id="prev">Prev</button>
    <span id="pos" style="align-self:center;font-size:13px;color:var(--mute)">1 / ${slides.length}</span>
    <button id="next">Next</button>
  </div>
  ${notes ? `<div class="notes">Speaker: stay on the problem for 20 seconds, then click. Don’t read the lede aloud.</div>` : ""}
</div>
<script>
  let i = 0;
  const slides = [...document.querySelectorAll('.slide')];
  function go(n){ i = (n+slides.length)%slides.length; slides.forEach((s,idx)=>s.classList.toggle('on', idx===i)); document.getElementById('pos').textContent = (i+1)+' / '+slides.length; }
  document.getElementById('prev').onclick = () => go(i-1);
  document.getElementById('next').onclick = () => go(i+1);
  window.addEventListener('keydown', e => { if(e.key==='ArrowRight'||e.key===' ') go(i+1); if(e.key==='ArrowLeft') go(i-1); });
</script>`;
  return wrap(title, body, c, extra);
}

export function tutorialHtml(): string {
  const c = sysColors();
  const body = `
<main style="max-width:760px;margin:0 auto;padding:72px 28px 96px">
  <p style="letter-spacing:.18em;text-transform:uppercase;font-size:11px;color:var(--mute);margin:0 0 14px">Quick tutorial</p>
  <h1 style="font-size:56px;line-height:.96;margin:0 0 18px">How Grok Design works</h1>
  <p style="font-size:18px;color:var(--mute);line-height:1.55">Chat on the left. Canvas on the right. You describe an artifact — a prototype, a deck, a one-pager — and Grok builds a first version you can actually click.</p>
  <ol style="padding:0;margin:40px 0 0;list-style:none;display:grid;gap:18px">
    ${[
      ["Talk", "Ask for a landing page, a four-screen flow, or a pitch deck. Be specific about audience and layout."],
      ["Comment", "Switch to Comment and pin notes on exact elements. Check the ones you want sent, then batch them."],
      ["Tweak", "Turn Tweaks on. Sliders and color chips Grok created for this file update the canvas live."],
      ["Edit & draw", "Change copy in place. Sketch on the canvas. Ask Grok to apply the markup across the design."],
      ["Export", "HTML, PDF, PPTX-ready slides, a zip, or a handoff bundle for Grok Code."],
    ]
      .map(
        ([h, p], i) =>
          `<li style="display:grid;grid-template-columns:48px 1fr;gap:14px;align-items:start"><div style="width:48px;height:48px;border-radius:12px;border:1px solid var(--line);display:grid;place-items:center;font-family:Newsreader,serif;font-size:20px">0${i + 1}</div><div><h3 style="margin:0 0 4px;font-size:22px">${h}</h3><p style="margin:0;color:var(--mute);line-height:1.5">${p}</p></div></li>`,
      )
      .join("")}
  </ol>
</main>`;
  return wrap("Learn about Grok Design", body, c);
}
