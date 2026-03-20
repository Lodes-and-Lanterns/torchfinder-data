/**
 * scripts/issue-to-pr.ts
 *
 * Parses a GitHub issue body (from an issue form), validates the content,
 * writes files, runs the build validator, and creates a branch + PR.
 *
 * Required env vars:
 *   GITHUB_TOKEN        fine-grained PAT with Contents + Pull Requests write
 *   GITHUB_REPOSITORY   "owner/repo"
 *   ISSUE_NUMBER        issue number (string)
 *   ISSUE_BODY          full issue body markdown
 *   ISSUE_TITLE         issue title
 *   ISSUE_AUTHOR        GitHub username of the submitter
 *   ISSUE_TYPE          "new-entry" | "update-entry" | "remove-entry"
 *
 * Run with:
 *   deno run --allow-read --allow-write --allow-run --allow-env scripts/issue-to-pr.ts
 */

import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml";
import {
  type EntryFields,
  generateEntryYaml,
  isUnchanged,
  parseIssueBody,
  parseLines,
  parseLinks,
  titleToId,
} from "./lib.ts";

// Env
//////

const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const GITHUB_REPOSITORY = Deno.env.get("GITHUB_REPOSITORY") ?? "";
const ISSUE_NUMBER = Deno.env.get("ISSUE_NUMBER") ?? "";
const ISSUE_BODY = Deno.env.get("ISSUE_BODY") ?? "";
const ISSUE_TITLE = Deno.env.get("ISSUE_TITLE") ?? "";
const ISSUE_AUTHOR = Deno.env.get("ISSUE_AUTHOR") ?? "";
const ISSUE_TYPE = Deno.env.get("ISSUE_TYPE") ?? "";

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !ISSUE_NUMBER || !ISSUE_TYPE) {
  console.error("Missing required environment variables.");
  Deno.exit(1);
}

// Taxonomy loader
//////////////////

async function loadTaxonomies(): Promise<Record<string, string[]>> {
  const taxonomies: Record<string, string[]> = {};
  for await (const dirent of Deno.readDir("schema/taxonomies")) {
    if (dirent.isFile && dirent.name.endsWith(".yaml")) {
      const stem = dirent.name.replace(/\.yaml$/, "");
      const raw = await Deno.readTextFile(`schema/taxonomies/${dirent.name}`);
      taxonomies[stem] = parseYaml(raw) as string[];
    }
  }
  return taxonomies;
}

// Removed list
///////////////

interface RemovedEntry {
  id: string;
  title: string;
  date: string;
  reason: string;
}

async function loadRemoved(): Promise<RemovedEntry[]> {
  try {
    const raw = await Deno.readTextFile("schema/removed.yaml");
    return (parseYaml(raw) as RemovedEntry[]) ?? [];
  } catch {
    return [];
  }
}

// Taxonomy utilities
/////////////////////

/**
 * Ensures all values exist in the given taxonomy, adding any unknown ones.
 * Mutates the in-memory taxonomies record, writes the updated file, and
 * records the file path in modifiedFiles.
 */
async function ensureTaxonomyValues(
  taxonomies: Record<string, string[]>,
  key: string,
  values: string[],
  modifiedFiles: Set<string>,
): Promise<void> {
  const known = taxonomies[key] ?? [];
  const newValues = values.filter((v) => !known.includes(v));
  if (newValues.length === 0) return;
  const updated = [...known, ...newValues].sort();
  taxonomies[key] = updated;
  const filePath = `schema/taxonomies/${key}.yaml`;
  await Deno.writeTextFile(filePath, stringifyYaml(updated));
  for (const v of newValues) {
    console.log(`Added new taxonomy value "${v}" to ${key}`);
  }
  modifiedFiles.add(filePath);
}

// Shell utilities
//////////////////

async function run(
  cmd: string[],
  opts: { cwd?: string; capture?: boolean } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await p.output();
  return {
    success,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

// GitHub API utilities
///////////////////////

async function ghComment(issueNumber: string, body: string): Promise<void> {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    console.error("Failed to post comment:", await res.text());
  }
}

async function ghAddLabel(issueNumber: string, label: string): Promise<void> {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) {
    console.error("Failed to add label:", await res.text());
  }
}

async function ghCreatePR(params: {
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<string> {
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      head: params.head,
      base: params.base,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create PR: ${await res.text()}`);
  }
  const json = await res.json() as { html_url: string };
  return json.html_url;
}

// Error handler
////////////////

async function failWithComment(message: string): Promise<never> {
  console.error(message);
  await ghComment(
    ISSUE_NUMBER,
    `## Automation error\n\n${message}\n\n---\n*This error was reported by the issue-to-pr workflow. Fix the issue and a curator can re-apply the \`ready\` label.*`,
  );
  await ghAddLabel(ISSUE_NUMBER, "bot:error");
  Deno.exit(1);
}

// Build runner
///////////////

async function runBuild(): Promise<void> {
  const result = await run(["deno", "run", "--allow-read", "build.ts"]);
  if (!result.success) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    await failWithComment(`Build/validation failed:\n\n\`\`\`\n${output}\n\`\`\``);
  }
}

// Git utilities
////////////////

async function gitSetup(): Promise<void> {
  await run(["git", "config", "user.name", "torchfinder-bot"]);
  await run(["git", "config", "user.email", "bot@users.noreply.github.com"]);
}

async function gitCreateBranch(branch: string): Promise<void> {
  const result = await run(["git", "checkout", "-b", branch]);
  if (!result.success) {
    await failWithComment(`Failed to create branch \`${branch}\`:\n\`\`\`\n${result.stderr}\n\`\`\``);
  }
}

async function gitCommitAndPush(files: string[], message: string, branch: string): Promise<void> {
  for (const f of files) {
    await run(["git", "add", f]);
  }
  const commitResult = await run(["git", "commit", "-m", message]);
  if (!commitResult.success) {
    await failWithComment(
      `Failed to commit:\n\`\`\`\n${commitResult.stderr}\n\`\`\``,
    );
  }
  const pushResult = await run(["git", "push", "-u", "origin", branch]);
  if (!pushResult.success) {
    await failWithComment(
      `Failed to push branch \`${branch}\`:\n\`\`\`\n${pushResult.stderr}\n\`\`\``,
    );
  }
}

// PR body template
///////////////////

function prBody(): string {
  return `Closes #${ISSUE_NUMBER}

Submitted via issue by @${ISSUE_AUTHOR}.

---
*Auto-generated by the issue-to-pr workflow.*`;
}

// Handler: new-entry
/////////////////////

async function handleNewEntry(fields: Map<string, string>): Promise<void> {
  const taxonomies = await loadTaxonomies();

  const title = (fields.get("Content title") ?? "").trim();
  const id = titleToId(title);
  const authorsRaw = fields.get("Authors") ?? "";
  const categoriesRaw = fields.get("Categories") ?? "";
  const systemsRaw = fields.get("Systems") ?? "";
  const settingsRaw = fields.get("Settings") ?? "";
  const linksRaw = fields.get("Links (optional)") ?? "";
  const date = (fields.get("Date") ?? "").trim();
  const envsRaw = fields.get("Environments (optional)") ?? "";
  const themesRaw = fields.get("Themes (optional)") ?? "";
  const characterOptionsRaw = fields.get("Character options (optional)") ?? "";
  const lminRaw = (fields.get("Min level (optional)") ?? "").trim();
  const lmaxRaw = (fields.get("Max level (optional)") ?? "").trim();
  const pminRaw = (fields.get("Min players (optional)") ?? "").trim();
  const pmaxRaw = (fields.get("Max players (optional)") ?? "").trim();
  const desc = (fields.get("Description (optional)") ?? "").trim();
  const pagesRaw = (fields.get("Pages (optional)") ?? "").trim();
  const cover = (fields.get("Cover image URL (optional)") ?? "").trim();
  const pub = (fields.get("Publisher (optional)") ?? "").trim();
  const includedInRaw = fields.get("Included in (optional)") ?? "";
  const officialRaw = fields.get("Official content") ?? "";
  const official = officialRaw.includes("[x]");

  const errors: string[] = [];

  // Required fields
  if (!title) errors.push("Title is required.");
  if (id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    errors.push(`Could not derive a valid ID from title "${title}". Generated slug "${id}" is invalid. Please open a blank issue to request manual addition.`);
  }

  // Block permanently removed IDs
  const removed = await loadRemoved();
  const removedEntry = removed.find((r) => r.id === id);
  if (removedEntry) {
    await failWithComment(
      `Entry \`${id}\` has been permanently removed from the dataset (reason: ${removedEntry.reason}). Re-addition through automation is blocked. Contact a maintainer if you believe this should be reconsidered.`,
    );
  }

  const authors = parseLines(authorsRaw);
  if (authors.length === 0) errors.push("At least one author is required.");

  const categories = parseLines(categoriesRaw);
  if (categories.length === 0) errors.push("At least one category is required.");

  const systems = parseLines(systemsRaw);
  if (systems.length === 0) errors.push("At least one system is required.");

  const settings = parseLines(settingsRaw);
  if (settings.length === 0) errors.push("At least one setting is required.");

  if (!date) errors.push("Date is required.");

  // Auto-add any unknown taxonomy values to the canonical files
  const modifiedTaxonomyFiles = new Set<string>();
  await ensureTaxonomyValues(taxonomies, "categories", categories, modifiedTaxonomyFiles);
  await ensureTaxonomyValues(taxonomies, "systems", systems, modifiedTaxonomyFiles);
  await ensureTaxonomyValues(taxonomies, "settings", settings, modifiedTaxonomyFiles);

  const envs = parseLines(envsRaw);
  await ensureTaxonomyValues(taxonomies, "environments", envs, modifiedTaxonomyFiles);
  const themes = parseLines(themesRaw);
  await ensureTaxonomyValues(taxonomies, "themes", themes, modifiedTaxonomyFiles);
  // Links (optional, warn on parse errors but do not require at least one)
  const { links, errors: linkErrors } = parseLinks(linksRaw, taxonomies.link_types, taxonomies.pricings);
  errors.push(...linkErrors);

  // Numeric fields
  let lmin: number | undefined;
  let lmax: number | undefined;
  let pmin: number | undefined;
  let pmax: number | undefined;
  let pages: number | undefined;

  if (lminRaw) {
    const n = parseInt(lminRaw, 10);
    if (isNaN(n)) errors.push(`lmin must be an integer, got "${lminRaw}"`);
    else lmin = n;
  }
  if (lmaxRaw) {
    const n = parseInt(lmaxRaw, 10);
    if (isNaN(n)) errors.push(`lmax must be an integer, got "${lmaxRaw}"`);
    else lmax = n;
  }
  if (lmin !== undefined && lmax !== undefined && lmin > lmax) {
    errors.push(`lmin (${lmin}) must be ≤ lmax (${lmax})`);
  }
  if (pminRaw) {
    const n = parseInt(pminRaw, 10);
    if (isNaN(n)) errors.push(`pmin must be an integer, got "${pminRaw}"`);
    else pmin = n;
  }
  if (pmaxRaw) {
    const n = parseInt(pmaxRaw, 10);
    if (isNaN(n)) errors.push(`pmax must be an integer, got "${pmaxRaw}"`);
    else pmax = n;
  }
  if (pmin !== undefined && pmax !== undefined && pmin > pmax) {
    errors.push(`pmin (${pmin}) must be ≤ pmax (${pmax})`);
  }
  if (pagesRaw) {
    const n = parseInt(pagesRaw, 10);
    if (isNaN(n)) errors.push(`pages must be an integer, got "${pagesRaw}"`);
    else pages = n;
  }

  // Cover URL
  if (cover && !cover.startsWith("https://")) {
    errors.push(`Cover URL must start with https://, got "${cover}"`);
  }

  // Check for duplicate ID
  try {
    await Deno.stat(`data/${id}.yaml`);
    errors.push(`Generated ID \`${id}\` (from title "${title}") already exists in the dataset. A curator can rename the ID in the PR to resolve the conflict.`);
  } catch {
    // File doesn't exist
  }

  if (errors.length > 0) {
    await failWithComment(
      `Found ${errors.length} validation error(s):\n\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }

  const entryData: EntryFields = {
    id,
    title,
    authors,
    categories,
    systems,
    settings,
    links,
    date,
    ...(envs.length > 0 ? { envs } : {}),
    ...(themes.length > 0 ? { themes } : {}),
    ...(parseLines(characterOptionsRaw).length > 0 ? { character_options: parseLines(characterOptionsRaw) } : {}),
    ...(lmin !== undefined ? { lmin } : {}),
    ...(lmax !== undefined ? { lmax } : {}),
    ...(pmin !== undefined ? { pmin } : {}),
    ...(pmax !== undefined ? { pmax } : {}),
    ...(desc ? { desc } : {}),
    ...(pages !== undefined ? { pages } : {}),
    ...(cover ? { cover } : {}),
    ...(pub ? { pub } : {}),
    ...(parseLines(includedInRaw).length > 0
      ? { included_in: parseLines(includedInRaw) }
      : {}),
    ...(official ? { official: true } : {}),
  };

  const yaml = generateEntryYaml(entryData);
  const filePath = `data/${id}.yaml`;
  await Deno.writeTextFile(filePath, yaml);
  console.log(`Wrote ${filePath}`);

  await runBuild();

  const branch = `bot/new-entry/issue-${ISSUE_NUMBER}-${id}`;
  await gitSetup();
  await gitCreateBranch(branch);
  await gitCommitAndPush(
    [filePath, ...modifiedTaxonomyFiles],
    `Add new entry: ${title} (closes #${ISSUE_NUMBER})`,
    branch,
  );

  const prUrl = await ghCreatePR({
    title: `Add new entry: ${title}`,
    body: prBody(),
    head: branch,
    base: "main",
  });

  await ghComment(ISSUE_NUMBER, `PR created: ${prUrl}`);
  await ghAddLabel(ISSUE_NUMBER, "bot:pr-created");
  console.log(`Done. PR: ${prUrl}`);
}

// Handler: update-entry
////////////////////////

async function handleUpdateEntry(fields: Map<string, string>): Promise<void> {
  const taxonomies = await loadTaxonomies();

  const id = (fields.get("Entry ID") ?? "").trim();

  if (!id) {
    await failWithComment("Entry ID is required.");
  }

  // Block permanently removed IDs
  const removed = await loadRemoved();
  if (removed.find((r) => r.id === id)) {
    await failWithComment(`Entry \`${id}\` has been permanently removed from the dataset and cannot be updated.`);
  }

  const filePath = `data/${id}.yaml`;
  let fileContent: string;
  try {
    fileContent = await Deno.readTextFile(filePath);
  } catch {
    await failWithComment(
      `No entry found with id "${id}". Check that the ID matches an existing file in \`data/\`.`,
    );
  }

  // Parse existing entry
  // deno-lint-ignore no-explicit-any
  const existing = parseYaml(fileContent!) as Record<string, any>;

  const errors: string[] = [];

  // Apply update to a field if not unchanged
  // deno-lint-ignore no-explicit-any
  function applyScalar(fieldKey: string, issueKey: string, transform?: (v: string) => any) {
    const raw = (fields.get(issueKey) ?? "").trim();
    if (isUnchanged(raw)) return;
    existing[fieldKey] = transform ? transform(raw) : raw;
  }

  function applyList(fieldKey: string, issueKey: string) {
    const raw = fields.get(issueKey) ?? "";
    if (isUnchanged(raw)) return;
    const values = parseLines(raw);
    existing[fieldKey] = values.length > 0 ? values : null;
  }

  function applyNullableInt(fieldKey: string, issueKey: string) {
    const raw = (fields.get(issueKey) ?? "").trim();
    if (isUnchanged(raw)) return;
    if (raw === "") {
      // Explicitly blank so clear the field
      existing[fieldKey] = null;
      return;
    }
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      errors.push(`${issueKey} must be an integer or blank, got "${raw}"`);
    } else {
      existing[fieldKey] = n;
    }
  }

  applyScalar("title", "Content title");
  applyList("authors", "Authors");

  const modifiedTaxonomyFiles = new Set<string>();

  const categoriesRaw = fields.get("Categories") ?? "";
  if (!isUnchanged(categoriesRaw)) {
    const categories = parseLines(categoriesRaw);
    if (categories.length === 0) errors.push("At least one category is required.");
    await ensureTaxonomyValues(taxonomies, "categories", categories, modifiedTaxonomyFiles);
    existing.categories = categories;
  }

  const systemsRaw = fields.get("Systems") ?? "";
  if (!isUnchanged(systemsRaw)) {
    const systems = parseLines(systemsRaw);
    if (systems.length === 0) errors.push("At least one system is required.");
    await ensureTaxonomyValues(taxonomies, "systems", systems, modifiedTaxonomyFiles);
    existing.systems = systems;
  }

  const settingsRaw = fields.get("Settings") ?? "";
  if (!isUnchanged(settingsRaw)) {
    const settings = parseLines(settingsRaw);
    if (settings.length === 0) errors.push("At least one setting is required.");
    await ensureTaxonomyValues(taxonomies, "settings", settings, modifiedTaxonomyFiles);
    existing.settings = settings;
  }

  const linksRaw = fields.get("Links") ?? "";
  if (!isUnchanged(linksRaw)) {
    const { links, errors: linkErrors } = parseLinks(linksRaw, taxonomies.link_types, taxonomies.pricings);
    errors.push(...linkErrors);
    if (linkErrors.length === 0) {
      existing.links = links;
    }
  }

  applyScalar("date", "Date");

  const envsRaw = fields.get("Environments") ?? "";
  if (!isUnchanged(envsRaw)) {
    const envs = parseLines(envsRaw);
    await ensureTaxonomyValues(taxonomies, "environments", envs, modifiedTaxonomyFiles);
    existing.envs = envs.length > 0 ? envs : null;
  }

  const themesRaw = fields.get("Themes") ?? "";
  if (!isUnchanged(themesRaw)) {
    const themes = parseLines(themesRaw);
    await ensureTaxonomyValues(taxonomies, "themes", themes, modifiedTaxonomyFiles);
    existing.themes = themes.length > 0 ? themes : null;
  }

  const characterOptionsRaw = fields.get("Character options") ?? "";
  if (!isUnchanged(characterOptionsRaw)) {
    const characterOptions = parseLines(characterOptionsRaw);
    existing.character_options = characterOptions.length > 0 ? characterOptions : null;
  }

  applyNullableInt("lmin", "Min level");
  applyNullableInt("lmax", "Max level");
  applyNullableInt("pmin", "Min players");
  applyNullableInt("pmax", "Max players");
  applyScalar("desc", "Description");
  applyNullableInt("pages", "Pages");

  const coverRaw = (fields.get("Cover image URL") ?? "").trim();
  if (!isUnchanged(coverRaw)) {
    if (coverRaw === "") {
      existing.cover = null;
    } else if (!coverRaw.startsWith("https://")) {
      errors.push(`Cover URL must start with https://, got "${coverRaw}"`);
    } else {
      existing.cover = coverRaw;
    }
  }

  applyScalar("pub", "Publisher");

  const includedInRaw = fields.get("Included in") ?? "";
  if (!isUnchanged(includedInRaw)) {
    const ids = parseLines(includedInRaw);
    existing.included_in = ids.length > 0 ? ids : null;
  }

  const officialRaw = (fields.get("Official content") ?? "").trim().toLowerCase();
  if (!isUnchanged(officialRaw)) {
    if (officialRaw === "true") {
      existing.official = true;
    } else if (officialRaw === "false" || officialRaw === "") {
      delete existing.official;
    } else {
      errors.push(`Official content must be "true", "false", or left as "(unchanged)", got "${officialRaw}"`);
    }
  }

  // Range checks after all updates applied
  if (
    existing.lmin != null &&
    existing.lmax != null &&
    existing.lmin > existing.lmax
  ) {
    errors.push(`lmin (${existing.lmin}) must be ≤ lmax (${existing.lmax})`);
  }
  if (
    existing.pmin != null &&
    existing.pmax != null &&
    existing.pmin > existing.pmax
  ) {
    errors.push(`pmin (${existing.pmin}) must be ≤ pmax (${existing.pmax})`);
  }

  if (errors.length > 0) {
    await failWithComment(
      `Found ${errors.length} validation error(s):\n\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }

  // Rebuild the YAML from the updated object. Remove null fields.
  for (const key of Object.keys(existing)) {
    if (existing[key] === null) delete existing[key];
  }

  // Use stringifyYaml for update-entry (preserves round-trip accuracy)
  const updatedYaml = stringifyYaml(existing, { lineWidth: 0 });
  await Deno.writeTextFile(filePath, updatedYaml);
  console.log(`Updated ${filePath}`);

  await runBuild();

  const branch = `bot/update-entry/issue-${ISSUE_NUMBER}-${id}`;
  await gitSetup();
  await gitCreateBranch(branch);
  await gitCommitAndPush(
    [filePath, ...modifiedTaxonomyFiles],
    `Update entry: ${id} (closes #${ISSUE_NUMBER})`,
    branch,
  );

  const prTitle = ISSUE_TITLE.startsWith("Update entry:")
    ? ISSUE_TITLE
    : `Update entry: ${id}`;

  const prUrl = await ghCreatePR({
    title: prTitle,
    body: prBody(),
    head: branch,
    base: "main",
  });

  await ghComment(ISSUE_NUMBER, `PR created: ${prUrl}`);
  await ghAddLabel(ISSUE_NUMBER, "bot:pr-created");
  console.log(`Done. PR: ${prUrl}`);
}

// Handler: remove-entry
////////////////////////

async function handleRemoveEntry(fields: Map<string, string>): Promise<void> {
  const id = (fields.get("Entry ID") ?? "").trim();
  const reason = (fields.get("Reason for removal") ?? "").trim();

  if (!id) {
    await failWithComment("Entry ID is required.");
  }

  // Check not already in the removed list
  const removed = await loadRemoved();
  if (removed.find((r) => r.id === id)) {
    await failWithComment(`Entry \`${id}\` is already in the permanent removal list.`);
  }

  // Check entry exists in data/
  const filePath = `data/${id}.yaml`;
  let entryTitle = id;
  try {
    const raw = await Deno.readTextFile(filePath);
    const parsed = parseYaml(raw) as Record<string, unknown>;
    entryTitle = (parsed.title as string) ?? id;
  } catch {
    await failWithComment(
      `No entry found with id \`${id}\`. Verify the ID matches an existing file in \`data/\`.`,
    );
  }

  // Delete the entry file
  await Deno.remove(filePath);
  console.log(`Deleted ${filePath}`);

  // Append to removed.yaml
  removed.push({
    id,
    title: entryTitle,
    date: new Date().toISOString().split("T")[0],
    reason: reason || "No reason provided",
  });
  await Deno.writeTextFile("schema/removed.yaml", stringifyYaml(removed));
  console.log(`Added "${id}" to schema/removed.yaml`);

  await runBuild();

  const branch = `bot/remove-entry/issue-${ISSUE_NUMBER}-${id}`;
  await gitSetup();
  await gitCreateBranch(branch);
  await gitCommitAndPush(
    [filePath, "schema/removed.yaml"],
    `Remove entry: ${entryTitle} (closes #${ISSUE_NUMBER})`,
    branch,
  );

  const prUrl = await ghCreatePR({
    title: `Remove entry: ${entryTitle}`,
    body: prBody(),
    head: branch,
    base: "main",
  });

  await ghComment(ISSUE_NUMBER, `PR created: ${prUrl}`);
  await ghAddLabel(ISSUE_NUMBER, "bot:pr-created");
  console.log(`Done. PR: ${prUrl}`);
}

// Main
///////

const fields = parseIssueBody(ISSUE_BODY);

console.log(`Processing issue #${ISSUE_NUMBER} as type: ${ISSUE_TYPE}`);

switch (ISSUE_TYPE) {
  case "new-entry":
    await handleNewEntry(fields);
    break;
  case "update-entry":
    await handleUpdateEntry(fields);
    break;
  case "remove-entry":
    await handleRemoveEntry(fields);
    break;
  default:
    await failWithComment(`Unknown issue type: "${ISSUE_TYPE}"`);
}
