/**
 * Parse `grok models` text and pick an id the CLI will accept.
 * Dependency-free so tests can import it without spawning the CLI.
 */

export type GrokModelList = {
  defaultId: string | null;
  ids: string[];
};

/** Pull the starred default and the listed ids out of `grok models` output. */
export function parseGrokModelsOutput(text: string): GrokModelList {
  const ids: string[] = [];
  let defaultId: string | null = null;
  const header = text.match(/Default model:\s*(\S+)/);
  if (header?.[1]) defaultId = header[1];
  for (const line of text.split("\n")) {
    const star = line.match(/^\s*\*\s+(\S+)/);
    const dash = line.match(/^\s*-\s+(\S+)/);
    const id = star?.[1] ?? dash?.[1];
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
    if (star) defaultId = id;
  }
  return { defaultId, ids };
}

/**
 * Keep `requested` when the CLI lists it. Otherwise use the account default.
 * A missing listing means "omit -m" so the CLI picks its own default.
 */
export function chooseGrokModel(requested: string | undefined, listing: GrokModelList | null): string | undefined {
  if (!listing || (!listing.defaultId && listing.ids.length === 0)) return undefined;
  const want = requested?.trim();
  if (want && listing.ids.includes(want)) return want;
  return listing.defaultId ?? listing.ids[0];
}
