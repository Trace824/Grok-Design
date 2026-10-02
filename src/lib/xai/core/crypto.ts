/**
 * AES-256-GCM token encryption with a versioned keyring. **Server-only.**
 *
 * Env format (`XAI_TOKEN_ENC_KEY`):
 *   - one key:   `<base64 or hex of 32 bytes>`              (key id "k1")
 *   - rotation:  `k2:<key>,k1:<key>`   first entry encrypts, all entries decrypt
 *
 * Ciphertext format: `gcm1.<keyId>.<iv b64url>.<ciphertext b64url>.<tag b64url>`.
 * The AAD binds a ciphertext to `(userId, purpose)` so it cannot be replayed in
 * another user's row or another column.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Keyring = {
  activeId: string;
  keys: ReadonlyMap<string, Buffer>;
};

const PREFIX = "gcm1";

function decodeKey(raw: string): Buffer {
  const v = raw.trim();
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    buf = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  if (!buf || buf.length !== 32) {
    throw new Error("XAI_TOKEN_ENC_KEY entries must be 32 bytes (base64 or 64 hex chars)");
  }
  return buf;
}

/** Parse the env value. Throws on malformed input (never logs key material). */
export function parseKeyring(value: string | undefined | null): Keyring {
  const raw = (value ?? "").trim();
  if (!raw) throw new Error("XAI_TOKEN_ENC_KEY is not set");
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const keys = new Map<string, Buffer>();
  let activeId = "";
  for (const entry of entries) {
    const m = entry.match(/^([A-Za-z0-9_-]{1,16}):(.+)$/);
    const id = m ? m[1] : entries.length === 1 ? "k1" : "";
    if (!id) throw new Error("XAI_TOKEN_ENC_KEY with several keys needs `id:key` entries");
    if (keys.has(id)) throw new Error(`XAI_TOKEN_ENC_KEY has duplicate key id ${id}`);
    keys.set(id, decodeKey(m ? m[2] : entry));
    activeId ||= id;
  }
  return { activeId, keys };
}

function aad(userId: string, purpose: string): Buffer {
  return Buffer.from(`grok-design:xai:${purpose}:${userId}`, "utf8");
}

export function encryptSecret(
  keyring: Keyring,
  plaintext: string,
  ctx: { userId: string; purpose: string },
): string {
  const key = keyring.keys.get(keyring.activeId);
  if (!key) throw new Error("active encryption key missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ctx.userId, ctx.purpose));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, keyring.activeId, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(
  keyring: Keyring,
  token: string,
  ctx: { userId: string; purpose: string },
): string {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new Error("malformed ciphertext");
  const [, keyId, ivB64, ctB64, tagB64] = parts;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`unknown encryption key id ${keyId}`);
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(ctx.userId, ctx.purpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Key id embedded in a ciphertext (for lazy re-encryption after rotation). */
export function ciphertextKeyId(token: string): string | null {
  const parts = token.split(".");
  return parts.length === 5 && parts[0] === PREFIX ? parts[1] : null;
}
