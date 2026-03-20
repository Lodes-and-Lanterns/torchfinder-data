/**
 * torchfinder-data build script (Deno)
 *
 * Reads all YAML files from data/, validates them against the JSON Schema and
 * taxonomies, runs cross-entry checks, computes derived fields,
 * and writes dist/torchfinder-dataset.json and dist/torchfinder-dataset.jsonl.
 *
 * Exits with a nonzero code on any error;  a failed build never writes output.
 *
 * Run with --allow-write to produce output. Without it, the script validates
 * only and exits cleanly; this is the mode used by PR validation CI.
 */

import { parse as parseYaml } from "jsr:@std/yaml";
import Ajv from "npm:ajv";
import { checkSmartChars, type Entry, type EnrichedEntry, enrichEntries } from "./scripts/lib.ts";

// Load schema and taxonomies
/////////////////////////////

const schemaJson = await Deno.readTextFile("schema/torchfinder-entry.schema.json");
const schema = JSON.parse(schemaJson);

const taxonomies: Record<string, string[]> = {};
for await (const dirent of Deno.readDir("schema/taxonomies")) {
  if (dirent.isFile && dirent.name.endsWith(".yaml")) {
    const stem = dirent.name.replace(/\.yaml$/, "");
    const raw = await Deno.readTextFile(`schema/taxonomies/${dirent.name}`);
    taxonomies[stem] = parseYaml(raw) as string[];
  }
}

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(schema);

// Load removed list
////////////////////

let removedIds = new Set<string>();
try {
  const removedRaw = await Deno.readTextFile("schema/removed.yaml");
  const removedList = parseYaml(removedRaw) as Array<{ id: string }>;
  removedIds = new Set((removedList ?? []).map((r) => r.id));
} catch {
  // schema/removed.yaml missing or empty; nothing blocked
}

// Read and parse YAML files
////////////////////////////

const filenames: string[] = [];
for await (const dirent of Deno.readDir("data")) {
  if (dirent.isFile && dirent.name.endsWith(".yaml")) {
    filenames.push(dirent.name);
  }
}
filenames.sort();

const entries: Entry[] = [];
let hasErrors = false;

function fail(context: string, message: string) {
  console.error(`[${context}] ${message}`);
  hasErrors = true;
}


for (const filename of filenames) {
  const stem = filename.replace(/\.yaml$/, "");
  let raw: unknown;

  try {
    raw = parseYaml(await Deno.readTextFile(`data/${filename}`));
  } catch (e) {
    fail(filename, `YAML parse error: ${e}`);
    continue;
  }

  // Smart/curly character check
  for (const msg of checkSmartChars(raw)) fail(filename, msg);

  // JSON Schema validation
  if (!validateSchema(raw)) {
    for (const err of validateSchema.errors ?? []) {
      fail(filename, `${err.instancePath || "(root)"} ${err.message}`);
    }
    continue;
  }

  const entry = raw as Entry;

  // id must match filename stem
  if (entry.id !== stem) {
    fail(filename, `id "${entry.id}" does not match filename "${stem}"`);
  }

  entries.push(entry);
}

// Cross-entry checks
/////////////////////

// Duplicate IDs
const idCount = new Map<string, number>();
for (const e of entries) idCount.set(e.id, (idCount.get(e.id) ?? 0) + 1);
for (const [id, count] of idCount) {
  if (count > 1) {
    fail("dataset", `Duplicate id "${id}" appears ${count} times`);
  }
}

// Removed IDs; entries whose IDs appear in schema/removed.yaml must not exist in data/
for (const e of entries) {
  if (removedIds.has(e.id)) {
    fail(e.id, `id "${e.id}" is permanently removed; delete this file from data/`);
  }
}

const idSet = new Set(entries.map((e) => e.id));

// Per-entry validation
const taxFields: Array<{ field: keyof Entry; vocab: string; isArray: boolean }> = [
  { field: "categories", vocab: "categories", isArray: true },
  { field: "systems", vocab: "systems", isArray: true },
  { field: "settings", vocab: "settings", isArray: true },
  { field: "envs", vocab: "environments", isArray: true },
  { field: "themes", vocab: "themes", isArray: true },
];

for (const entry of entries) {
  // Taxonomy values
  for (const { field, vocab, isArray } of taxFields) {
    const allowed = taxonomies[vocab];
    if (!allowed) continue;
    const raw = entry[field];
    const values: string[] = isArray
      ? ((raw as string[] | undefined) ?? [])
      : raw != null
        ? [raw as string]
        : [];
    for (const v of values) {
      if (!allowed.includes(v)) {
        console.warn(`[${entry.id}] unknown ${field} value "${v}"; known values: ${allowed.join(", ")}`);
      }
    }
  }

  // Level range
  if (
    entry.lmin != null &&
    entry.lmax != null &&
    entry.lmin > entry.lmax
  ) {
    fail(entry.id, `lmin (${entry.lmin}) > lmax (${entry.lmax})`);
  }

  // Party size range
  if (
    entry.pmin != null &&
    entry.pmax != null &&
    entry.pmin > entry.pmax
  ) {
    fail(
      entry.id,
      `pmin (${entry.pmin}) > pmax (${entry.pmax})`,
    );
  }

  // Link types and pricing
  const allowedLinkTypes = taxonomies["link_types"];
  const allowedLinkPricings = taxonomies["pricings"];
  for (const link of entry.links ?? []) {
    if (allowedLinkTypes && !allowedLinkTypes.includes(link.type)) {
      console.warn(`[${entry.id}] unknown link type "${link.type}"; known values: ${allowedLinkTypes.join(", ")}`);
    }
    if (allowedLinkPricings && !allowedLinkPricings.includes(link.pricing)) {
      console.warn(`[${entry.id}] unknown link pricing "${link.pricing}"; known values: ${allowedLinkPricings.join(", ")}`);
    }
  }

  // included_in references
  for (const parentId of entry.included_in ?? []) {
    if (!idSet.has(parentId)) {
      fail(entry.id, `included_in references unknown id "${parentId}"`);
    }
  }
}

// Exit on errors
/////////////////

if (hasErrors) {
  console.error("\nBuild failed. Resolve the errors above before merging.");
  Deno.exit(1);
}

// Compute derived fields
/////////////////////////

const enriched: EnrichedEntry[] = enrichEntries(entries);

// Write output
///////////////

enriched.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

const n = enriched.length;
const noun = n === 1 ? "entry" : "entries";

const canWrite = (await Deno.permissions.query({ name: "write", path: "dist" })).state === "granted";

if (canWrite) {
  await Deno.mkdir("dist", { recursive: true });
  await Deno.writeTextFile("dist/torchfinder-dataset.json", JSON.stringify(enriched));
  await Deno.writeTextFile(
    "dist/torchfinder-dataset.jsonl",
    enriched.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  console.log(`Build successful: ${n} ${noun} written to dist/`);
} else {
  console.log(`Validation successful: ${n} ${noun} validated (read-only mode, output skipped)`);
}
