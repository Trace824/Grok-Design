/**
 * DB-backed project persistence for cross-browser share.
 *
 * When `DATABASE_URL` is unset, every handler no-ops and the client keeps using
 * Zustand `localStorage` only. When set, upsert/get/getShared talk to Postgres
 * (Neon / Fly) via `getSql()`.
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  Fidelity,
  ModelId,
  Project,
  ProjectKind,
  ShareAccess,
  Tweak,
} from "./types";

function hasDatabaseUrl(): boolean {
  const raw =
    typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
  return Boolean(raw && raw.trim());
}

export type SharedProjectPayload = {
  id: string;
  name: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  html: string;
  tweaks: Tweak[];
  share: ShareAccess;
  model: ModelId;
};

export type UpsertProjectInput = {
  id: string;
  userId?: string | null;
  name: string;
  kind: ProjectKind;
  fidelity: Fidelity;
  html: string;
  tweaks: Tweak[];
  share: ShareAccess;
  model: ModelId;
  createdAt?: number;
  updatedAt?: number;
};

function parseTweaks(raw: unknown): Tweak[] {
  if (Array.isArray(raw)) return raw as Tweak[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as Tweak[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export const upsertProject = createServerFn({ method: "POST" })
  .validator((input: UpsertProjectInput) => input)
  .handler(async ({ data }) => {
    if (!hasDatabaseUrl()) return { ok: false as const, reason: "no-db" as const };
    const { getSql } = await import("./db");
    const sql = await getSql();
    const tweaksJson = JSON.stringify(data.tweaks ?? []);
    const createdAt = new Date(data.createdAt ?? Date.now());
    const updatedAt = new Date(data.updatedAt ?? Date.now());
    await sql.query(
      `INSERT INTO projects (
         id, user_id, name, kind, fidelity, html, tweaks, share, model, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11
       )
       ON CONFLICT (id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, projects.user_id),
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         fidelity = EXCLUDED.fidelity,
         html = EXCLUDED.html,
         tweaks = EXCLUDED.tweaks,
         share = EXCLUDED.share,
         model = EXCLUDED.model,
         updated_at = EXCLUDED.updated_at`,
      [
        data.id,
        data.userId ?? null,
        data.name,
        data.kind,
        data.fidelity,
        data.html,
        tweaksJson,
        data.share,
        data.model,
        createdAt,
        updatedAt,
      ],
    );
    return { ok: true as const };
  });

export const getProjectRecord = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<SharedProjectPayload | null> => {
    if (!hasDatabaseUrl()) return null;
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{
      id: string;
      name: string;
      kind: string;
      fidelity: string;
      html: string;
      tweaks: unknown;
      share: string;
      model: string;
    }>(
      `SELECT id, name, kind, fidelity, html, tweaks, share, model
       FROM projects WHERE id = $1 LIMIT 1`,
      [data.id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as ProjectKind,
      fidelity: row.fidelity as Fidelity,
      html: row.html,
      tweaks: parseTweaks(row.tweaks),
      share: row.share as ShareAccess,
      model: row.model as ModelId,
    };
  });

export const getSharedProject = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<SharedProjectPayload | null> => {
    if (!hasDatabaseUrl()) return null;
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{
      id: string;
      name: string;
      kind: string;
      fidelity: string;
      html: string;
      tweaks: unknown;
      share: string;
      model: string;
    }>(
      `SELECT id, name, kind, fidelity, html, tweaks, share, model
       FROM projects
       WHERE id = $1 AND share <> 'private'
       LIMIT 1`,
      [data.id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as ProjectKind,
      fidelity: row.fidelity as Fidelity,
      html: row.html,
      tweaks: parseTweaks(row.tweaks),
      share: row.share as ShareAccess,
      model: row.model as ModelId,
    };
  });

/** Fire-and-forget client helper — no-ops server-side when DATABASE_URL is unset. */
export function persistProjectSnapshot(project: Project): void {
  if (typeof window === "undefined") return;
  void upsertProject({
    data: {
      id: project.id,
      name: project.name,
      kind: project.kind,
      fidelity: project.fidelity,
      html: project.html,
      tweaks: project.tweaks,
      share: project.share,
      model: project.model,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  }).catch(() => {
    // Best-effort; localStorage remains source of truth offline.
  });
}
