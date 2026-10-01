import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import matter from "gray-matter";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./export-wiki.mjs", import.meta.url));

test("wiki export previews safely and writes non-overwriting draft posts", async (context) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magma-wiki-export-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));

  const wiki = path.join(temp, "wiki");
  const output = path.join(temp, "posts");
  const hermesHome = path.join(temp, "hermes-home");
  await fs.mkdir(path.join(wiki, "entities"), { recursive: true });
  await fs.mkdir(path.join(wiki, "concepts"), { recursive: true });
  await fs.mkdir(path.join(wiki, "queries"), { recursive: true });
  await fs.mkdir(path.join(wiki, "raw", "articles"), { recursive: true });
  await fs.mkdir(hermesHome, { recursive: true });
  await fs.writeFile(path.join(hermesHome, ".env"), `OPENAI_API_KEY=do-not-print-this\nWIKI_PATH="${wiki}"\n`);
  await fs.writeFile(path.join(wiki, "entities", "operations.md"), [
    "---",
    "title: Operations Note",
    "created: 2026-09-30",
    "updated: 2026-09-30",
    "type: concept",
    "tags: [operations, writing]",
    "---",
    "",
    "# Operations Note",
    "",
    "A useful paragraph with [[review workflow]] and **clear guidance**.",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(wiki, "concepts", "draft.md"), "---\ntitle: Hidden Draft\ntype: concept\ndraft: true\n---\n\nNot exported.\n");
  await fs.writeFile(path.join(wiki, "queries", "untyped.md"), "---\ntitle: Missing Type\n---\n\nNot exported.\n");
  await fs.writeFile(path.join(wiki, "queries", "oversized.md"), `---\ntitle: Oversized Note\ntype: query\n---\n\n${"x".repeat(100_001)}\n`);
  await fs.writeFile(path.join(wiki, "raw", "articles", "source.md"), "Raw source is never exported.\n");

  const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--source", wiki, "--output", output, ...args], { encoding: "utf8" });
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /1 eligible page\(s\), 3 skipped\. No files written\./);
  await assert.rejects(fs.readdir(output), { code: "ENOENT" });

  const configured = spawnSync(process.execPath, [SCRIPT, "--output", output], {
    encoding: "utf8",
    env: { ...process.env, HERMES_HOME: hermesHome, WIKI_PATH: "" },
  });
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /1 eligible page\(s\), 3 skipped/);
  assert.doesNotMatch(`${configured.stdout}${configured.stderr}`, /do-not-print-this/);

  const written = run("--write");
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /1 draft\(s\) created/);
  const [filename] = await fs.readdir(output);
  assert.match(filename, /^wiki-entities-operations-[a-f0-9]{10}\.md$/);
  const destination = path.join(output, filename);
  const content = await fs.readFile(destination, "utf8");
  const parsed = matter(content);
  assert.equal(parsed.data.title, "Operations Note");
  assert.match(content, /^date: 2026-09-30$/m);
  assert.equal(parsed.data.draft, true);
  assert.deepEqual(parsed.data.tags, ["operations", "writing"]);
  assert.match(parsed.content, /review workflow/);
  assert.doesNotMatch(parsed.content, /\[\[|Operations Note/);

  await fs.writeFile(destination, `${content}\nOwner edit.\n`);
  const repeated = run("--write");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /0 draft\(s\) created, 1 existing file\(s\) left unchanged/);
  assert.match(await fs.readFile(destination, "utf8"), /Owner edit\./);
});
