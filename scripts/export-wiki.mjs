import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECTIONS = ["entities", "concepts", "comparisons", "queries"];
const TYPES = new Set(["entity", "concept", "comparison", "query", "summary"]);
const LIMITS = { title: 160, content: 100_000, tags: 20, tag: 50 };
const HELP = `Usage: npm run export:wiki -- [--source <wiki-path>] [--write]

Reads reviewed Markdown pages from entities/, concepts/, comparisons/, and queries/.
Preview is the default. --write creates unpublished draft posts without overwriting files.
Set WIKI_PATH, configure it in Hermes' .env, or pass --source to select the wiki directory.`;

async function main() {
  const { source, output, write } = parseArgs(process.argv.slice(2));
  if (source === "help") {
    console.log(HELP);
    return;
  }

  const configuredPath = source || process.env.WIKI_PATH?.trim() || (await readHermesWikiPath());
  const wikiRoot = path.resolve(expandHome(configuredPath || path.join(os.homedir(), "wiki")));
  const stat = await fs.stat(wikiRoot).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Wiki directory not found: ${wikiRoot}`);

  const postsDir = path.resolve(output ?? path.join(ROOT, "content", "posts"));
  const pages = [];
  let skipped = 0;
  for (const section of SECTIONS) {
    const files = await markdownFiles(path.join(wikiRoot, section));
    for (const file of files) {
      const page = await readPage(file, wikiRoot);
      if (page) pages.push(page);
      else skipped += 1;
    }
  }

  pages.sort((a, b) => a.slug.localeCompare(b.slug));
  if (!write) {
    console.log(`Preview: ${pages.length} eligible page(s), ${skipped} skipped. No files written.`);
    console.log("Run again with --write to create draft posts.");
    return;
  }

  await fs.mkdir(postsDir, { recursive: true });
  let created = 0;
  let existing = 0;
  for (const page of pages) {
    const destination = path.join(postsDir, `${page.slug}.md`);
    try {
      await fs.writeFile(destination, page.markdown, { encoding: "utf8", flag: "wx" });
      created += 1;
    } catch (error) {
      if (error.code === "EEXIST") existing += 1;
      else throw error;
    }
  }
  console.log(`Export complete: ${created} draft(s) created, ${existing} existing file(s) left unchanged, ${skipped} page(s) skipped.`);
}

async function readHermesWikiPath() {
  const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const envFile = path.join(hermesHome, ".env");
  const contents = await fs.readFile(envFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw new Error("Unable to read Hermes environment configuration");
  });
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?WIKI_PATH\s*=\s*(.*?)\s*$/);
    if (match) {
      const value = parseEnvValue(match[1]);
      if (value) return value;
    }
  }
  return "";
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "").trim();
}

function expandHome(value) {
  return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

function parseArgs(args) {
  let source;
  let output;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help" || args[index] === "-h") return { source: "help", write };
    if (args[index] === "--write") {
      write = true;
      continue;
    }
    if (args[index] === "--source" && args[index + 1]) {
      source = args[index + 1];
      index += 1;
      continue;
    }
    if (args[index] === "--output" && args[index + 1]) {
      output = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  return { source, output, write };
}

async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...(await markdownFiles(fullPath)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
  }
  return files;
}

async function readPage(file, wikiRoot) {
  let parsed;
  try {
    parsed = matter(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  const type = typeof parsed.data.type === "string" ? parsed.data.type : "";
  const title = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  if (!TYPES.has(type) || !title || parsed.data.draft === true) return null;

  const body = cleanBody(parsed.content, title);
  const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags.filter((tag) => typeof tag === "string") : [];
  if (title.length > LIMITS.title || body.length > LIMITS.content || tags.length > LIMITS.tags || tags.some((tag) => tag.length > LIMITS.tag)) return null;
  const description = textExcerpt(body, parsed.data.description);
  if (!body || !description) return null;

  const relativePath = path.relative(wikiRoot, file).split(path.sep).join("/");
  const slug = makeSlug(relativePath);
  const date = validDate(parsed.data.updated ?? parsed.data.created);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `date: ${date}`,
    `tags: ${JSON.stringify(tags)}`,
    "draft: true",
    "---",
    "",
  ].join("\n");

  return { slug, markdown: `${frontmatter}${body}\n` };
}

function cleanBody(content, title) {
  let body = content.trim().replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  const firstHeading = body.match(/^#\s+([^\n]+)\n+/);
  if (firstHeading?.[1].trim() === title) body = body.slice(firstHeading[0].length).trim();
  return body;
}

function textExcerpt(body, declared) {
  if (typeof declared === "string" && declared.trim()) return declared.trim().slice(0, 240);
  const paragraph = body
    .split(/\n\s*\n/)
    .find((block) => block.trim() && !/^\s*(?:#|>|```|\|)/.test(block));
  if (!paragraph) return "";
  return paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function makeSlug(relativePath) {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 10);
  const readable = relativePath
    .replace(/\.md$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 54)
    .replace(/-+$/g, "");
  return `wiki-${readable ? `${readable}-` : ""}${hash}`;
}

function validDate(value) {
  const candidate = value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate) return candidate;
  }
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error(`Wiki export failed: ${error.message}`);
  process.exitCode = 1;
});
