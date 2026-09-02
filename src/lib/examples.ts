import type { Fidelity, ProjectKind } from "./types";

export type ExampleCard = {
  id: string;
  title: string;
  blurb: string;
  prompt: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  tag: string;
};

export const EXAMPLES: ExampleCard[] = [
  {
    id: "ex_saas",
    title: "Northline analytics",
    blurb: "SaaS marketing site with pricing and a quiet product frame.",
    prompt:
      "Design a high-fidelity marketing site for Northline, a B2B analytics product. Hero with a product frame, three proof points, a pricing table (Starter / Team / Scale), and a calm footer. Editorial, not startup-purple. Audience: VP ops.",
    kind: "prototype",
    fidelity: "hifi",
    tag: "Landing",
  },
  {
    id: "ex_dash",
    title: "Revenue desk",
    blurb: "Internal dashboard with region filters and a twelve-month chart.",
    prompt:
      "Create a dashboard showing monthly revenue with filters for region and product line. Dense but readable. KPI row, line chart, and a transactions table. Desktop first.",
    kind: "prototype",
    fidelity: "hifi",
    tag: "Dashboard",
  },
  {
    id: "ex_mobile",
    title: "Still — meditation",
    blurb: "Four-screen iOS onboarding with calming type.",
    prompt:
      "Prototype a serene mobile meditation app called Still. Four onboarding screens, calming typography, subtle nature-inspired colors, clean layout. High fidelity.",
    kind: "prototype",
    fidelity: "hifi",
    tag: "Mobile",
  },
  {
    id: "ex_deck",
    title: "Seed narrative",
    blurb: "Eight-slide on-brand pitch with speaker notes.",
    prompt:
      "Build an 8-slide seed pitch deck for a design-to-code tool. Problem, market, product, traction, team, ask. Use speaker notes. High fidelity, not stock-template.",
    kind: "slides",
    fidelity: "hifi",
    tag: "Deck",
  },
  {
    id: "ex_wire",
    title: "Checkout flow",
    blurb: "Low-fi wireframes for cart → pay → confirm.",
    prompt:
      "Wireframe a three-step checkout flow for a fashion store: cart, payment, confirmation. Desktop. Gray boxes, labels, no color. Focus on hierarchy and empty states.",
    kind: "prototype",
    fidelity: "wireframe",
    tag: "Wireframe",
  },
  {
    id: "ex_one",
    title: "Founder one-pager",
    blurb: "Single-page brief ready to export as PDF.",
    prompt:
      "Create a founder one-pager for a climate hardware company. Tight grid, one photograph-like panel, three proof numbers, and a contact strip. Export-ready.",
    kind: "other",
    fidelity: "hifi",
    tag: "Document",
  },
  {
    id: "ex_shader",
    title: "Ink field wallpaper",
    blurb: "Interactive canvas field that reacts to the pointer.",
    prompt:
      "Build an interactive wallpaper: a dark field of slow ink filaments that follow the mouse. No UI chrome except a tiny caption. Frontier / shader energy, still tasteful.",
    kind: "other",
    fidelity: "hifi",
    tag: "Frontier",
  },
  {
    id: "ex_docs",
    title: "API product page",
    blurb: "Landing with hero, code sample, and pricing.",
    prompt:
      "Build a landing page for a new API product with a hero, a real-looking code example, three use cases, and pricing. Dark code well, light page.",
    kind: "prototype",
    fidelity: "hifi",
    tag: "Landing",
  },
];
