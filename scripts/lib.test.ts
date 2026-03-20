/**
 * scripts/lib.test.ts
 *
 * Unit tests for pure utility functions in scripts/lib.ts.
 *
 * Run with:
 *   deno test scripts/lib.test.ts
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "jsr:@std/assert";
import {
  checkSmartChars,
  compareSchemas,
  compareTaxonomyValues,
  enrichEntries,
  generateEntryYaml,
  isUnchanged,
  parseIssueBody,
  parseLines,
  parseLinks,
  titleToId,
  typeFingerprint,
  yamlList,
  yamlLinks,
  yamlScalar,
} from "./lib.ts";

// parseIssueBody
/////////////////

Deno.test("parseIssueBody: empty string returns empty map", () => {
  assertEquals(parseIssueBody("").size, 0);
});

Deno.test("parseIssueBody: single section", () => {
  const body = "### Content title\n\nMy Adventure\n";
  const result = parseIssueBody(body);
  assertEquals(result.get("Content title"), "My Adventure");
});

Deno.test("parseIssueBody: multiple sections", () => {
  const body = [
    "### Content title",
    "",
    "My Adventure",
    "",
    "### Authors",
    "",
    "Alice",
    "Bob",
    "",
    "### Date",
    "",
    "2024-01-15",
  ].join("\n");

  const result = parseIssueBody(body);
  assertEquals(result.get("Content title"), "My Adventure");
  assertEquals(result.get("Authors"), "Alice\nBob");
  assertEquals(result.get("Date"), "2024-01-15");
});

Deno.test("parseIssueBody: blank value is preserved as empty string", () => {
  const body = "### Optional field\n\n\n### Next field\n\nvalue";
  const result = parseIssueBody(body);
  assertEquals(result.get("Optional field"), "");
  assertEquals(result.get("Next field"), "value");
});

Deno.test("parseIssueBody: header with extra whitespace", () => {
  const body = "###  Spaced Label  \n\nvalue\n";
  const result = parseIssueBody(body);
  assertEquals(result.get("Spaced Label"), "value");
});

Deno.test("parseIssueBody: does not include non-header lines as keys", () => {
  const body = "Some preamble text\n\n### Real Section\n\nvalue";
  const result = parseIssueBody(body);
  assertEquals(result.has("Some preamble text"), false);
  assertEquals(result.get("Real Section"), "value");
});

// parseLines
/////////////

Deno.test("parseLines: empty string returns empty array", () => {
  assertEquals(parseLines(""), []);
});

Deno.test("parseLines: blank lines are filtered", () => {
  assertEquals(parseLines("\n\n\n"), []);
});

Deno.test("parseLines: trims and filters", () => {
  assertEquals(parseLines("  Alice  \n  \n  Bob  \n"), ["Alice", "Bob"]);
});

Deno.test("parseLines: single value", () => {
  assertEquals(parseLines("Shadowdark"), ["Shadowdark"]);
});

Deno.test("parseLines: multiple values", () => {
  assertEquals(parseLines("Adventure\nSuplement\nZine"), [
    "Adventure",
    "Suplement",
    "Zine",
  ]);
});

// isUnchanged
//////////////

Deno.test("isUnchanged: empty string is unchanged", () => {
  assertEquals(isUnchanged(""), true);
});

Deno.test("isUnchanged: whitespace-only is unchanged", () => {
  assertEquals(isUnchanged("   "), true);
});

Deno.test("isUnchanged: (unchanged) is unchanged", () => {
  assertEquals(isUnchanged("(unchanged)"), true);
});

Deno.test("isUnchanged: (unchanged) is case-insensitive", () => {
  assertEquals(isUnchanged("(UNCHANGED)"), true);
  assertEquals(isUnchanged("(Unchanged)"), true);
});

Deno.test("isUnchanged: (unchanged) with surrounding spaces", () => {
  assertEquals(isUnchanged("  (unchanged)  "), true);
});

Deno.test("isUnchanged: real value is not unchanged", () => {
  assertEquals(isUnchanged("My Title"), false);
});

Deno.test("isUnchanged: (unchanged) with extra text is not unchanged", () => {
  assertEquals(isUnchanged("(unchanged) extra"), false);
  assertEquals(isUnchanged("extra (unchanged)"), false);
});

// titleToId
////////////

Deno.test("titleToId: basic title", () => {
  assertEquals(titleToId("The Dark Dungeon"), "the-dark-dungeon");
});

Deno.test("titleToId: lowercase conversion", () => {
  assertEquals(titleToId("MY ADVENTURE"), "my-adventure");
});

Deno.test("titleToId: accented characters are stripped", () => {
  assertEquals(titleToId("Château Noir"), "chateau-noir");
  assertEquals(titleToId("Münchhausen"), "munchhausen");
  assertEquals(titleToId("Résumé"), "resume");
});

Deno.test("titleToId: special characters become hyphens", () => {
  assertEquals(titleToId("Hello, World!"), "hello-world");
});

Deno.test("titleToId: multiple special chars collapse to one hyphen", () => {
  assertEquals(titleToId("A -- B"), "a-b");
});

Deno.test("titleToId: leading and trailing hyphens are trimmed", () => {
  assertEquals(titleToId("!Hello!"), "hello");
});

Deno.test("titleToId: numbers are preserved", () => {
  assertEquals(titleToId("Module 3: The Lair"), "module-3-the-lair");
});

Deno.test("titleToId: apostrophes become hyphens", () => {
  assertEquals(titleToId("Wizard's Tome"), "wizard-s-tome");
});

// yamlScalar
/////////////

Deno.test("yamlScalar: plain string passes through unchanged", () => {
  assertEquals(yamlScalar("hello"), "hello");
  assertEquals(yamlScalar("My Adventure"), "My Adventure");
});

Deno.test("yamlScalar: empty string is quoted", () => {
  assertEquals(yamlScalar(""), '""');
});

Deno.test("yamlScalar: YAML reserved words are quoted", () => {
  assertEquals(yamlScalar("null"), '"null"');
  assertEquals(yamlScalar("true"), '"true"');
  assertEquals(yamlScalar("false"), '"false"');
  assertEquals(yamlScalar("yes"), '"yes"');
  assertEquals(yamlScalar("no"), '"no"');
  assertEquals(yamlScalar("on"), '"on"');
  assertEquals(yamlScalar("off"), '"off"');
  assertEquals(yamlScalar("~"), '"~"');
});

Deno.test("yamlScalar: YAML reserved words case variants are quoted", () => {
  assertEquals(yamlScalar("True"), '"True"');
  assertEquals(yamlScalar("NULL"), '"NULL"');
  assertEquals(yamlScalar("YES"), '"YES"');
});

Deno.test("yamlScalar: strings with special chars are quoted", () => {
  assertEquals(yamlScalar("hello: world"), '"hello: world"');
  assertEquals(yamlScalar("key#value"), '"key#value"');
  assertEquals(yamlScalar("a[b]"), '"a[b]"');
  assertEquals(yamlScalar("pipe|delimited"), '"pipe|delimited"');
});

Deno.test("yamlScalar: strings starting with digit are quoted", () => {
  assertEquals(yamlScalar("1st Edition"), '"1st Edition"');
  assertEquals(yamlScalar("2024-01-01"), '"2024-01-01"');
});

Deno.test("yamlScalar: strings starting with dot are quoted", () => {
  assertEquals(yamlScalar(".inf"), '".inf"');
  assertEquals(yamlScalar(".hidden"), '".hidden"');
});

Deno.test("yamlScalar: leading/trailing spaces are quoted", () => {
  assertEquals(yamlScalar(" leading"), '" leading"');
  assertEquals(yamlScalar("trailing "), '"trailing "');
});

Deno.test("yamlScalar: strings with single quotes are quoted", () => {
  assertMatch(yamlScalar("it's"), /^"/);
});

// yamlList
///////////

Deno.test("yamlList: basic list without indent", () => {
  assertEquals(yamlList(["a", "b", "c"]), "- a\n- b\n- c");
});

Deno.test("yamlList: list with indent", () => {
  assertEquals(yamlList(["x", "y"], "  "), "  - x\n  - y");
});

Deno.test("yamlList: single item", () => {
  assertEquals(yamlList(["only"]), "- only");
});

// parseLinks
/////////////

const KNOWN_TYPES = ["ebook", "print", "vtt", "web", "ebook-and-print"];
const KNOWN_PRICINGS = ["free", "paid", "pwyw"];

Deno.test("parseLinks: empty string returns empty results", () => {
  const { links, errors } = parseLinks("", KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(links, []);
  assertEquals(errors, []);
});

Deno.test("parseLinks: valid single link", () => {
  const line = "My Book | https://example.com/book | en | ebook | paid";
  const { links, errors } = parseLinks(line, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(errors, []);
  assertEquals(links.length, 1);
  assertEquals(links[0], {
    title: "My Book",
    url: "https://example.com/book",
    language: "en",
    type: "ebook",
    pricing: "paid",
  });
});

Deno.test("parseLinks: multiple valid links", () => {
  const raw = [
    "PDF | https://example.com/pdf | en | ebook | free",
    "Print | https://example.com/print | en | print | paid",
  ].join("\n");
  const { links, errors } = parseLinks(raw, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(errors, []);
  assertEquals(links.length, 2);
  assertEquals(links[0].title, "PDF");
  assertEquals(links[1].title, "Print");
});

Deno.test("parseLinks: missing fields produces error", () => {
  const line = "Title | https://example.com | en | ebook";
  const { links, errors } = parseLinks(line, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(links, []);
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /5 pipe-separated fields/);
});

Deno.test("parseLinks: non-https URL produces error and drops link", () => {
  const line = "Title | http://example.com | en | ebook | free";
  const { links, errors } = parseLinks(line, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(links, []);
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /must start with https/);
});

Deno.test("parseLinks: invalid language tag produces error and drops link", () => {
  const line = "Title | https://example.com | english | ebook | free";
  const { links, errors } = parseLinks(line, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(links, []);
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /Invalid language tag/);
});

Deno.test("parseLinks: valid language subtag is accepted", () => {
  const line = "Title | https://example.com | pt-BR | ebook | free";
  const { links, errors } = parseLinks(line, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(errors, []);
  assertEquals(links[0].language, "pt-BR");
});

Deno.test("parseLinks: blank lines in input are ignored", () => {
  const raw = "\nTitle | https://example.com | en | ebook | free\n\n";
  const { links, errors } = parseLinks(raw, KNOWN_TYPES, KNOWN_PRICINGS);
  assertEquals(errors, []);
  assertEquals(links.length, 1);
});

// typeFingerprint
/////////////////

Deno.test("typeFingerprint: simple string type", () => {
  const fp = typeFingerprint({ type: "string", description: "ignored" });
  const parsed = JSON.parse(fp);
  assertEquals(parsed.type, "string");
  assertEquals(Object.keys(parsed).length, 1);
});

Deno.test("typeFingerprint: array type with item type", () => {
  const fp = typeFingerprint({
    type: "array",
    items: { type: "string" },
  });
  const parsed = JSON.parse(fp);
  assertEquals(parsed.type, "array");
  assertEquals(parsed.itemsType, "string");
});

Deno.test("typeFingerprint: array of objects includes item property keys", () => {
  const fp = typeFingerprint({
    type: "array",
    items: {
      type: "object",
      properties: { url: {}, title: {}, language: {} },
    },
  });
  const parsed = JSON.parse(fp);
  assertEquals(parsed.itemsPropertyKeys, ["language", "title", "url"]);
});

Deno.test("typeFingerprint: property keys are sorted", () => {
  const fp1 = typeFingerprint({
    type: "object",
    properties: { b: {}, a: {}, c: {} },
  });
  const fp2 = typeFingerprint({
    type: "object",
    properties: { c: {}, b: {}, a: {} },
  });
  assertEquals(fp1, fp2);
});

Deno.test("typeFingerprint: description and pattern do not affect fingerprint", () => {
  const fp1 = typeFingerprint({ type: "string", description: "foo", pattern: "^[a-z]+$" });
  const fp2 = typeFingerprint({ type: "string", description: "bar", minLength: 1 });
  assertEquals(fp1, fp2);
});

Deno.test("typeFingerprint: different types produce different fingerprints", () => {
  const fp1 = typeFingerprint({ type: "string" });
  const fp2 = typeFingerprint({ type: "integer" });
  assertNotEquals(fp1, fp2);
});

// generateEntryYaml
////////////////////

const MINIMAL_ENTRY = {
  id: "my-adventure",
  title: "My Adventure",
  authors: ["Alice"],
  categories: ["Adventure"],
  systems: ["Shadowdark"],
  settings: ["Setting-Agnostic"],
  links: [],
  date: "2024-01-15",
};

Deno.test("generateEntryYaml: minimal entry contains required fields", () => {
  const yaml = generateEntryYaml(MINIMAL_ENTRY);
  assertMatch(yaml, /^id: my-adventure$/m);
  assertMatch(yaml, /^title: My Adventure$/m);
  assertMatch(yaml, /^\s+- Alice$/m);
  assertMatch(yaml, /^\s+- Adventure$/m);
  assertMatch(yaml, /^\s+- Shadowdark$/m);
  assertMatch(yaml, /^date: "2024-01-15"$/m);
});

Deno.test("generateEntryYaml: ends with newline", () => {
  const yaml = generateEntryYaml(MINIMAL_ENTRY);
  assertEquals(yaml.endsWith("\n"), true);
});

Deno.test("generateEntryYaml: optional fields omitted when absent", () => {
  const yaml = generateEntryYaml(MINIMAL_ENTRY);
  assertEquals(yaml.includes("envs:"), false);
  assertEquals(yaml.includes("themes:"), false);
  assertEquals(yaml.includes("links:"), false);
  assertEquals(yaml.includes("desc:"), false);
  assertEquals(yaml.includes("lmin:"), false);
  assertEquals(yaml.includes("included_in:"), false);
  assertEquals(yaml.includes("official:"), false);
});

Deno.test("generateEntryYaml: official: true is emitted when set", () => {
  const yaml = generateEntryYaml({ ...MINIMAL_ENTRY, official: true });
  assertMatch(yaml, /^official: true$/m);
});

Deno.test("generateEntryYaml: official is omitted when false", () => {
  const yaml = generateEntryYaml({ ...MINIMAL_ENTRY, official: false });
  assertEquals(yaml.includes("official:"), false);
});

Deno.test("generateEntryYaml: optional fields included when present", () => {
  const yaml = generateEntryYaml({
    ...MINIMAL_ENTRY,
    envs: ["Dungeon"],
    themes: ["Horror"],
    lmin: 1,
    lmax: 5,
    pmin: 2,
    pmax: 4,
    pages: 32,
    desc: "A spooky dungeon crawl.",
    pub: "Lodes & Co.",
    included_in: ["mega-campaign"],
  });
  assertMatch(yaml, /^envs:$/m);
  assertMatch(yaml, /^\s+- Dungeon$/m);
  assertMatch(yaml, /^themes:$/m);
  assertMatch(yaml, /^\s+- Horror$/m);
  assertMatch(yaml, /^lmin: 1$/m);
  assertMatch(yaml, /^lmax: 5$/m);
  assertMatch(yaml, /^pmin: 2$/m);
  assertMatch(yaml, /^pmax: 4$/m);
  assertMatch(yaml, /^pages: 32$/m);
  assertMatch(yaml, /^desc: >$/m);
  assertMatch(yaml, /^included_in:$/m);
  assertMatch(yaml, /^\s+- mega-campaign$/m);
});

Deno.test("generateEntryYaml: link is rendered", () => {
  const yaml = generateEntryYaml({
    ...MINIMAL_ENTRY,
    links: [
      {
        title: "Buy on DTRPG",
        url: "https://example.com",
        language: "en",
        type: "ebook",
        pricing: "paid",
      },
    ],
  });
  assertMatch(yaml, /^links:$/m);
  assertMatch(yaml, /title: Buy on DTRPG/m);
  assertMatch(yaml, /url: "https:\/\/example\.com"/m);
  assertMatch(yaml, /language: en/m);
  assertMatch(yaml, /type: ebook/m);
  assertMatch(yaml, /pricing: paid/m);
});

Deno.test("generateEntryYaml: title with special chars is quoted", () => {
  const yaml = generateEntryYaml({
    ...MINIMAL_ENTRY,
    title: "The Wizard's: Guide",
  });
  assertMatch(yaml, /^title: "/m);
});

Deno.test("generateEntryYaml: multiple authors", () => {
  const yaml = generateEntryYaml({
    ...MINIMAL_ENTRY,
    authors: ["Alice", "Bob", "Carol"],
  });
  assertMatch(yaml, /^\s+- Alice$/m);
  assertMatch(yaml, /^\s+- Bob$/m);
  assertMatch(yaml, /^\s+- Carol$/m);
});

// enrichEntries
////////////////

const BASE_ENTRY = {
  id: "test-entry",
  title: "Test Entry",
  authors: ["Alice"],
  categories: ["Adventure"],
  systems: ["Shadowdark"],
  settings: ["Setting-Agnostic"],
  date: "2024-01-01",
};

Deno.test("enrichEntries: entry with no links gets empty languages and pricings", () => {
  const [result] = enrichEntries([BASE_ENTRY]);
  assertEquals(result.languages, []);
  assertEquals(result.pricings, []);
});

Deno.test("enrichEntries: extracts unique sorted languages from links", () => {
  const entry = {
    ...BASE_ENTRY,
    links: [
      { title: "A", url: "https://a.com", language: "fr", type: "ebook", pricing: "free" },
      { title: "B", url: "https://b.com", language: "en", type: "ebook", pricing: "free" },
      { title: "C", url: "https://c.com", language: "fr", type: "print", pricing: "paid" },
    ],
  };
  const [result] = enrichEntries([entry]);
  assertEquals(result.languages, ["en", "fr"]);
});

Deno.test("enrichEntries: extracts unique sorted pricings from links", () => {
  const entry = {
    ...BASE_ENTRY,
    links: [
      { title: "A", url: "https://a.com", language: "en", type: "ebook", pricing: "pwyw" },
      { title: "B", url: "https://b.com", language: "en", type: "print", pricing: "free" },
      { title: "C", url: "https://c.com", language: "en", type: "vtt", pricing: "pwyw" },
    ],
  };
  const [result] = enrichEntries([entry]);
  assertEquals(result.pricings, ["free", "pwyw"]);
});

Deno.test("enrichEntries: entry without included_in has no children field", () => {
  const [result] = enrichEntries([BASE_ENTRY]);
  assertEquals("children" in result, false);
});

Deno.test("enrichEntries: parent entry gets children from included_in references", () => {
  const parent = { ...BASE_ENTRY, id: "parent" };
  const child = { ...BASE_ENTRY, id: "child", included_in: ["parent"] };
  const results = enrichEntries([parent, child]);
  const parentResult = results.find((e) => e.id === "parent")!;
  assertEquals(parentResult.children, ["child"]);
});

Deno.test("enrichEntries: multiple children are all listed", () => {
  const parent = { ...BASE_ENTRY, id: "parent" };
  const child1 = { ...BASE_ENTRY, id: "child1", included_in: ["parent"] };
  const child2 = { ...BASE_ENTRY, id: "child2", included_in: ["parent"] };
  const results = enrichEntries([parent, child1, child2]);
  const parentResult = results.find((e) => e.id === "parent")!;
  assertEquals(parentResult.children?.sort(), ["child1", "child2"]);
});

Deno.test("enrichEntries: child entry does not get children field", () => {
  const parent = { ...BASE_ENTRY, id: "parent" };
  const child = { ...BASE_ENTRY, id: "child", included_in: ["parent"] };
  const results = enrichEntries([parent, child]);
  const childResult = results.find((e) => e.id === "child")!;
  assertEquals("children" in childResult, false);
});

// compareSchemas
/////////////////

const SCHEMA_BASE: { properties: Record<string, Record<string, unknown>>; required: string[] } = {
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    date: { type: "string" },
  },
  required: ["id", "title", "date"],
};

Deno.test("compareSchemas: identical schemas produce no changes", () => {
  const { breaking, nonBreaking } = compareSchemas(SCHEMA_BASE, SCHEMA_BASE);
  assertEquals(breaking, []);
  assertEquals(nonBreaking, []);
});

Deno.test("compareSchemas: removed field is breaking", () => {
  const curr = { ...SCHEMA_BASE, properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] };
  const { breaking } = compareSchemas(SCHEMA_BASE, curr);
  assertEquals(breaking, ["Field `date` removed"]);
});

Deno.test("compareSchemas: changed field type is breaking", () => {
  const curr = {
    ...SCHEMA_BASE,
    properties: { ...SCHEMA_BASE.properties, date: { type: "integer" } },
  };
  const { breaking } = compareSchemas(SCHEMA_BASE, curr);
  assertEquals(breaking, ["Field `date` type changed"]);
});

Deno.test("compareSchemas: newly required field is breaking", () => {
  const prev = { properties: SCHEMA_BASE.properties, required: ["id", "title"] };
  const { breaking } = compareSchemas(prev, SCHEMA_BASE);
  assertEquals(breaking, ["Field `date` is now required"]);
});

Deno.test("compareSchemas: field becoming optional is non-breaking", () => {
  const curr = { properties: SCHEMA_BASE.properties, required: ["id", "title"] };
  const { breaking, nonBreaking } = compareSchemas(SCHEMA_BASE, curr);
  assertEquals(breaking, []);
  assertEquals(nonBreaking, ["Field `date` is now optional"]);
});

Deno.test("compareSchemas: new optional field is non-breaking", () => {
  const curr = {
    properties: { ...SCHEMA_BASE.properties, desc: { type: "string" } },
    required: SCHEMA_BASE.required,
  };
  const { breaking, nonBreaking } = compareSchemas(SCHEMA_BASE, curr);
  assertEquals(breaking, []);
  assertEquals(nonBreaking, ["New optional field `desc` added"]);
});

Deno.test("compareSchemas: metadata-only change (description) is not a type change", () => {
  const curr = {
    ...SCHEMA_BASE,
    properties: { ...SCHEMA_BASE.properties, title: { type: "string", description: "new desc" } },
  };
  const { breaking } = compareSchemas(SCHEMA_BASE, curr);
  assertEquals(breaking, []);
});

// compareTaxonomyValues
///////////////////////

Deno.test("compareTaxonomyValues: identical lists produce no changes", () => {
  const { breaking, nonBreaking } = compareTaxonomyValues("categories", ["A", "B"], ["A", "B"]);
  assertEquals(breaking, []);
  assertEquals(nonBreaking, []);
});

Deno.test("compareTaxonomyValues: removed value is breaking", () => {
  const { breaking } = compareTaxonomyValues("categories", ["Adventure", "Zine"], ["Adventure"]);
  assertEquals(breaking, ["Taxonomy value `Zine` removed from `categories`"]);
});

Deno.test("compareTaxonomyValues: added value is non-breaking", () => {
  const { nonBreaking } = compareTaxonomyValues("categories", ["Adventure"], ["Adventure", "Zine"]);
  assertEquals(nonBreaking, ["Taxonomy value `Zine` added to `categories`"]);
});

Deno.test("compareTaxonomyValues: stem name appears in messages", () => {
  const { breaking } = compareTaxonomyValues("themes", ["Horror"], []);
  assertMatch(breaking[0], /`themes`/);
});

// yamlLinks
////////////

Deno.test("yamlLinks: renders link block", () => {
  const output = yamlLinks([
    { title: "PDF", url: "https://ex.com", language: "en", type: "ebook", pricing: "free" },
  ]);
  assertMatch(output, /title: PDF/);
  assertMatch(output, /url: "https:\/\/ex\.com"/);
  assertMatch(output, /language: en/);
  assertMatch(output, /type: ebook/);
  assertMatch(output, /pricing: free/);
});

Deno.test("yamlLinks: multiple links are joined with newline", () => {
  const output = yamlLinks([
    { title: "A", url: "https://a.com", language: "en", type: "ebook", pricing: "free" },
    { title: "B", url: "https://b.com", language: "fr", type: "print", pricing: "paid" },
  ]);
  assertMatch(output, /title: A/);
  assertMatch(output, /title: B/);
});

// checkSmartChars
//////////////////

Deno.test("checkSmartChars: clean string returns no errors", () => {
  assertEquals(checkSmartChars("hello world"), []);
});

Deno.test("checkSmartChars: left single quote is flagged", () => {
  const errors = checkSmartChars("\u2018hello");
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /U\+2018/);
});

Deno.test("checkSmartChars: right single quote is flagged", () => {
  const errors = checkSmartChars("world\u2019s");
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /U\+2019/);
});

Deno.test("checkSmartChars: left double quote is flagged", () => {
  const errors = checkSmartChars("\u201Cquoted\u201D");
  assertEquals(errors.length, 2);
});

Deno.test("checkSmartChars: nested object field is flagged with path", () => {
  const errors = checkSmartChars({ cover: "\u2018https://example.com" });
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /^cover /);
});

Deno.test("checkSmartChars: nested array element is flagged with path", () => {
  const errors = checkSmartChars({ authors: ["Alice", "Bob\u2019s Alt"] });
  assertEquals(errors.length, 1);
  assertMatch(errors[0], /^authors\[1\] /);
});

Deno.test("checkSmartChars: en dash and em dash are not flagged", () => {
  assertEquals(checkSmartChars("solo \u2013 adventure"), []);
  assertEquals(checkSmartChars("note \u2014 important"), []);
});

Deno.test("checkSmartChars: clean object returns no errors", () => {
  assertEquals(checkSmartChars({ title: "My Adventure", desc: "A dungeon crawl." }), []);
});
