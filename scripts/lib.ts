/**
 * scripts/lib.ts
 *
 * Pure utility functions shared by the automation scripts.
 * No side effects; safe to import in tests.
 */

// Issue body parser
////////////////////

/**
 * Parses a GitHub issue form body into a map of field label → value.
 *
 * Issue forms render as:
 *   ### Field Label
 *
 *   Value here
 *
 *   ### Next Field
 *   ...
 */
export function parseIssueBody(body: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = body.split(/\n(?=### )/);
  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0].trim();
    if (!headerLine.startsWith("### ")) continue;
    const key = headerLine.replace(/^###\s+/, "").trim();
    const valueLines = lines.slice(1).join("\n").trim();
    result.set(key, valueLines);
  }
  return result;
}

/**
 * Extracts lines from a textarea value (non-empty lines only).
 */
export function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Returns true if a field value should be treated as "no change".
 * Applies to update-entry fields that default to "(unchanged)".
 */
export function isUnchanged(s: string): boolean {
  return s.trim() === "" || /^\s*\(unchanged\)\s*$/i.test(s);
}

// Link parser
//////////////

export interface ParsedLink {
  title: string;
  url: string;
  language: string;
  type: string;
  pricing: string;
}

export function parseLinks(
  raw: string,
  knownTypes: string[],
  knownPricings: string[],
): { links: ParsedLink[]; errors: string[] } {
  const links: ParsedLink[] = [];
  const errors: string[] = [];

  for (const line of parseLines(raw)) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 5) {
      errors.push(`Invalid link format (expected 5 pipe-separated fields: title | url | language | type | pricing): "${line}"`);
      continue;
    }
    const [title, url, language, type, pricing] = parts;
    let lineErrors = false;
    if (!url.startsWith("https://")) {
      errors.push(`Link URL must start with https://: "${url}"`);
      lineErrors = true;
    }
    if (!language || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) {
      errors.push(`Invalid language tag "${language}" in link: "${line}"`);
      lineErrors = true;
    }
    if (lineErrors) continue;
    if (!knownTypes.includes(type)) {
      console.warn(`Unknown link type "${type}". Known values: ${knownTypes.join(", ")}`);
    }
    if (!knownPricings.includes(pricing)) {
      console.warn(`Unknown link pricing "${pricing}". Known values: ${knownPricings.join(", ")}`);
    }
    links.push({ title, url, language, type, pricing });
  }

  return { links, errors };
}

// YAML generation
//////////////////

/** Renders a YAML block list from an array of strings. */
export function yamlList(items: string[], indent = ""): string {
  return items.map((v) => `${indent}- ${v}`).join("\n");
}

/** Renders a YAML block list of link objects. */
export function yamlLinks(links: ParsedLink[]): string {
  return links
    .map(
      (l) =>
        `  - title: ${yamlScalar(l.title)}\n    url: ${yamlScalar(l.url)}\n    language: ${l.language}\n    type: ${l.type}\n    pricing: ${l.pricing}`,
    )
    .join("\n");
}

/** Derives a dataset ID slug from a content title. */
export function titleToId(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")                        // decompose accented chars
    .replace(/[\u0300-\u036f]/g, "")         // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")            // non-alphanumeric runs → hyphen
    .replace(/^-+|-+$/g, "");               // trim leading/trailing hyphens
}

export const YAML_RESERVED =
  /^(null|Null|NULL|~|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|\.inf|\.Inf|\.INF|-\.inf|-\.Inf|-\.INF|\.nan|\.NaN|\.NAN)$/;

/** Quotes a scalar if needed for safe YAML serialization. */
export function yamlScalar(s: string): string {
  if (
    s === "" ||
    YAML_RESERVED.test(s) ||
    /[:#\[\]{},|>&*!'"\\%@`]/.test(s) ||
    s.startsWith(" ") ||
    s.endsWith(" ") ||
    /^[-+]?[0-9]/.test(s) ||
    s.startsWith(".")
  ) {
    return JSON.stringify(s);
  }
  return s;
}

// Entry types
//////////////

export interface Entry {
  id: string;
  title: string;
  authors: string[];
  categories: string[];
  systems: string[];
  settings: string[];
  envs?: string[];
  themes?: string[];
  lmin?: number | null;
  lmax?: number | null;
  pmin?: number | null;
  pmax?: number | null;
  desc?: string | null;
  pages?: number | null;
  character_options?: string[];
  links?: ParsedLink[];
  cover?: string | null;
  pub?: string | null;
  included_in?: string[];
  official?: boolean;
  date: string;
}

export interface EnrichedEntry extends Entry {
  languages: string[];
  pricings: string[];
  children?: string[];
}

// Enrichment
/////////////

/**
 * Computes derived fields for each entry:
 *   - languages: unique, sorted language codes from links
 *   - pricings: unique, sorted pricing values from links
 *   - children: IDs of entries that reference this entry via included_in
 */
export function enrichEntries(entries: Entry[]): EnrichedEntry[] {
  const childrenMap = new Map<string, string[]>();
  for (const entry of entries) {
    for (const parentId of entry.included_in ?? []) {
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId)!.push(entry.id);
    }
  }
  return entries.map((entry) => {
    const children = childrenMap.get(entry.id) ?? [];
    return {
      ...entry,
      languages: [...new Set((entry.links ?? []).map((l) => l.language))].sort(),
      pricings: [...new Set((entry.links ?? []).map((l) => l.pricing))].sort(),
      ...(children.length > 0 ? { children } : {}),
    };
  });
}

// EntryFields (used for generating new YAML)
/////////////////////////////////////////////

export interface EntryFields {
  id: string;
  title: string;
  authors: string[];
  categories: string[];
  systems: string[];
  settings: string[];
  links: ParsedLink[];
  date: string;
  envs?: string[];
  themes?: string[];
  character_options?: string[];
  lmin?: number;
  lmax?: number;
  pmin?: number;
  pmax?: number;
  desc?: string;
  pages?: number;
  cover?: string;
  pub?: string;
  included_in?: string[];
  official?: boolean;
}

export function generateEntryYaml(f: EntryFields): string {
  const lines: string[] = [];
  lines.push(`id: ${f.id}`);
  lines.push(`title: ${yamlScalar(f.title)}`);
  lines.push(`authors:`);
  lines.push(yamlList(f.authors.map(yamlScalar), "  "));
  lines.push(`categories:`);
  lines.push(yamlList(f.categories, "  "));
  lines.push(`systems:`);
  lines.push(yamlList(f.systems, "  "));
  lines.push(`settings:`);
  lines.push(yamlList(f.settings, "  "));
  if (f.official === true) lines.push(`official: true`);
  if (f.envs && f.envs.length > 0) {
    lines.push(`envs:`);
    lines.push(yamlList(f.envs, "  "));
  }
  if (f.themes && f.themes.length > 0) {
    lines.push(`themes:`);
    lines.push(yamlList(f.themes, "  "));
  }
  if (f.character_options && f.character_options.length > 0) {
    lines.push(`character_options:`);
    lines.push(yamlList(f.character_options.map(yamlScalar), "  "));
  }
  if (f.lmin !== undefined) lines.push(`lmin: ${f.lmin}`);
  if (f.lmax !== undefined) lines.push(`lmax: ${f.lmax}`);
  if (f.pmin !== undefined) lines.push(`pmin: ${f.pmin}`);
  if (f.pmax !== undefined) lines.push(`pmax: ${f.pmax}`);
  if (f.desc) {
    lines.push(`desc: >`);
    lines.push(`  ${f.desc}`);
  }
  if (f.pages !== undefined) lines.push(`pages: ${f.pages}`);
  if (f.cover) lines.push(`cover: ${yamlScalar(f.cover)}`);
  if (f.links.length > 0) {
    lines.push(`links:`);
    lines.push(yamlLinks(f.links));
  }
  if (f.pub) lines.push(`pub: ${yamlScalar(f.pub)}`);
  if (f.included_in && f.included_in.length > 0) {
    lines.push(`included_in:`);
    lines.push(yamlList(f.included_in, "  "));
  }
  lines.push(`date: "${f.date}"`);
  return lines.join("\n") + "\n";
}

// Smart character detection
////////////////////////////

// Curly/smart quotes are flagged because they are visually identical to ASCII
// quotes but break schema pattern checks (e.g. URL fields) in confusing ways.
export const SMART_CHARS: Array<[string, string]> = [
  ["\u2018", "U+2018 LEFT SINGLE QUOTATION MARK \u2018"],
  ["\u2019", "U+2019 RIGHT SINGLE QUOTATION MARK \u2019"],
  ["\u201C", "U+201C LEFT DOUBLE QUOTATION MARK \u201C"],
  ["\u201D", "U+201D RIGHT DOUBLE QUOTATION MARK \u201D"],
];

/**
 * Recursively walks a parsed YAML value and collects error messages for any
 * string that contains a smart/curly quote character.
 *
 * Returns a list of error strings (empty if none found).
 */
export function checkSmartChars(value: unknown, path = ""): string[] {
  const errors: string[] = [];
  if (typeof value === "string") {
    for (const [char, label] of SMART_CHARS) {
      if (value.includes(char)) {
        errors.push(`${path} contains ${label}. Replace with its ASCII equivalent`);
      }
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...checkSmartChars(value[i], `${path}[${i}]`));
    }
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      errors.push(...checkSmartChars(v, path ? `${path}.${k}` : k));
    }
  }
  return errors;
}

// Schema diff
//////////////

export type SchemaShape = {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

/**
 * Classifies changes between two JSON Schema shapes as breaking or non-breaking
 * from the perspective of a third-party dataset consumer.
 */
export function compareSchemas(
  prev: SchemaShape,
  curr: SchemaShape,
): { breaking: string[]; nonBreaking: string[] } {
  const breaking: string[] = [];
  const nonBreaking: string[] = [];
  const prevProps = prev.properties ?? {};
  const currProps = curr.properties ?? {};

  // Removed fields → breaking
  for (const key of Object.keys(prevProps)) {
    if (!(key in currProps)) {
      breaking.push(`Field \`${key}\` removed`);
    }
  }

  // Changed field types → breaking
  for (const key of Object.keys(prevProps)) {
    if (key in currProps) {
      if (typeFingerprint(prevProps[key]) !== typeFingerprint(currProps[key])) {
        breaking.push(`Field \`${key}\` type changed`);
      }
    }
  }

  const prevRequired = new Set(prev.required ?? []);
  const currRequired = new Set(curr.required ?? []);

  // Newly required fields → breaking
  for (const field of currRequired) {
    if (!prevRequired.has(field)) {
      breaking.push(`Field \`${field}\` is now required`);
    }
  }

  // Fields no longer required → non-breaking
  for (const field of prevRequired) {
    if (!currRequired.has(field)) {
      nonBreaking.push(`Field \`${field}\` is now optional`);
    }
  }

  // New optional fields → non-breaking
  for (const key of Object.keys(currProps)) {
    if (!(key in prevProps)) {
      nonBreaking.push(`New optional field \`${key}\` added`);
    }
  }

  return { breaking, nonBreaking };
}

/**
 * Classifies changes to a single taxonomy as breaking (removed values) or
 * non-breaking (added values).
 */
export function compareTaxonomyValues(
  stem: string,
  prev: string[],
  curr: string[],
): { breaking: string[]; nonBreaking: string[] } {
  const breaking = prev
    .filter((v) => !curr.includes(v))
    .map((v) => `Taxonomy value \`${v}\` removed from \`${stem}\``);
  const nonBreaking = curr
    .filter((v) => !prev.includes(v))
    .map((v) => `Taxonomy value \`${v}\` added to \`${stem}\``);
  return { breaking, nonBreaking };
}

/**
 * Produces a stable fingerprint for the consumer-visible parts of a JSON
 * Schema property node: its type, array item type, and (for objects) the set
 * of property keys. Ignores metadata like description, pattern, minimum, etc.
 */
export function typeFingerprint(node: Record<string, unknown>): string {
  const parts: Record<string, unknown> = { type: node.type ?? null };
  if (node.items && typeof node.items === "object") {
    const items = node.items as Record<string, unknown>;
    parts.itemsType = items.type ?? null;
    if (items.properties && typeof items.properties === "object") {
      parts.itemsPropertyKeys = Object.keys(items.properties as object).sort();
    }
  }
  if (node.properties && typeof node.properties === "object") {
    parts.propertyKeys = Object.keys(node.properties as object).sort();
  }
  return JSON.stringify(parts);
}
