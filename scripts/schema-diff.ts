/**
 * scripts/schema-diff.ts
 *
 * Compares the current entry schema and taxonomy files against a previous
 * release tag and classifies changes as breaking or non-breaking for
 * third-party consumers of the dataset.
 *
 * A change is "breaking" if it can cause existing consumer code to fail or
 * silently produce wrong results:
 *   - A field is removed or renamed
 *   - A field's type changes
 *   - A field becomes required that wasn't before
 *   - A taxonomy value is removed (consumers filtering by it get empty results)
 *
 * Non-breaking changes:
 *   - New optional fields added
 *   - A field becomes optional that was required
 *   - New taxonomy values added
 *
 * Usage:
 *   deno run --allow-read --allow-run scripts/schema-diff.ts <prev-tag>
 *
 * Outputs JSON to stdout:
 *   {
 *     breaking: string[],
 *     nonBreaking: string[],
 *     hasChanges: boolean,
 *     hasBreaking: boolean
 *   }
 */

import { parse as parseYaml } from "jsr:@std/yaml";
import { compareSchemas, compareTaxonomyValues, type SchemaShape } from "./lib.ts";

const prevTag = Deno.args[0];
if (!prevTag) {
  console.error("Usage: schema-diff.ts <prev-tag>");
  Deno.exit(1);
}

// Utilities
////////////

async function gitShow(tag: string, path: string): Promise<string | null> {
  const result = await new Deno.Command("git", {
    args: ["show", `${tag}:${path}`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) return null;
  return new TextDecoder().decode(result.stdout);
}

// Schema comparison
////////////////////

const breaking: string[] = [];
const nonBreaking: string[] = [];

const currentSchemaRaw = await Deno.readTextFile("schema/torchfinder-entry.schema.json");
const currentSchema = JSON.parse(currentSchemaRaw) as SchemaShape;

const prevSchemaRaw = await gitShow(prevTag, "schema/torchfinder-entry.schema.json");

if (prevSchemaRaw) {
  const prevSchema = JSON.parse(prevSchemaRaw) as SchemaShape;
  const result = compareSchemas(prevSchema, currentSchema);
  breaking.push(...result.breaking);
  nonBreaking.push(...result.nonBreaking);
}

// Taxonomy comparison
//////////////////////

for await (const dirent of Deno.readDir("schema/taxonomies")) {
  if (!dirent.isFile || !dirent.name.endsWith(".yaml")) continue;
  const filePath = `schema/taxonomies/${dirent.name}`;
  const stem = dirent.name.replace(/\.yaml$/, "");

  const currentRaw = await Deno.readTextFile(filePath);
  const currentValues = (parseYaml(currentRaw) as string[]) ?? [];

  const prevRaw = await gitShow(prevTag, filePath);
  if (!prevRaw) {
    nonBreaking.push(`New taxonomy \`${stem}\` added`);
    continue;
  }

  const prevValues = (parseYaml(prevRaw) as string[]) ?? [];
  const result = compareTaxonomyValues(stem, prevValues, currentValues);
  breaking.push(...result.breaking);
  nonBreaking.push(...result.nonBreaking);
}

// Output
/////////

console.log(JSON.stringify({
  breaking,
  nonBreaking,
  hasChanges: breaking.length > 0 || nonBreaking.length > 0,
  hasBreaking: breaking.length > 0,
}, null, 2));
