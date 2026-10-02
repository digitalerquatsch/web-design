import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRepo, createGithub, buildProjectInput, summarizeProject, GithubError } from "../src/github.js";
import { createApp } from "../src/app.js";
import { buildPrompt, withDefaults } from "../public/prompt.js";

test("parseRepo accepts the usual spellings and rejects anything else", () => {
  for (const s of ["digitalerquatsch/jarvis", "https://github.com/digitalerquatsch/jarvis", "github.com/digitalerquatsch/jarvis/", "git@github.com:digitalerquatsch/jarvis.git", "https://github.com/digitalerquatsch/jarvis/tree/main?x=1"]) {
    assert.deepEqual(parseRepo(s), { owner: "digitalerquatsch", repo: "jarvis" }, s);
  }
  for (const s of ["", "jarvis", "../etc/passwd", "owner/..", "https://evil.com/a/b", "a b/c", "owner/repo name"]) {
    assert.throws(() => parseRepo(s), GithubError, s);
  }
});

const README = "# Nano-Banana MCP\nGenerate and edit images with Gemini 2.5 Flash Image.\n## Setup\n1. Get a Gemini key\n2. Add the server to your MCP client\n";
function fakeFetch(calls, { status = 200, privateRepo = false } = {}) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const u = new URL(url);
    assert.equal(u.host, "api.github.com", "only api.github.com is contacted");
    if (status !== 200) return new Response("{}", { status });
    if (u.pathname.endsWith("/readme")) return new Response(README);
    if (u.pathname.endsWith("/contents/")) return new Response(JSON.stringify([{ name: "src", type: "dir", path: "src" }, { name: "README.md", type: "file", path: "README.md" }, { name: "CLAUDE.md", type: "file", path: "CLAUDE.md" }]));
    if (u.pathname.endsWith("/contents/CLAUDE.md")) return new Response("Run npm test before committing.");
    return new Response(JSON.stringify({ html_url: "https://github.com/digitalerquatsch/Nano-Banana-MCP", description: "MCP server for image generation", topics: ["mcp", "gemini"], language: "TypeScript", private: privateRepo, stargazers_count: 7, pushed_at: "2026-09-01T00:00:00Z", license: { spdx_id: "MIT" }, homepage: "javascript:alert(1)" }));
  };
}

test("fetchRepo reads meta, README, layout and docs; the homepage must be http(s)", async () => {
  const calls = [];
  const r = await createGithub({ token: "ghp_x", fetchImpl: fakeFetch(calls) }).fetchRepo("digitalerquatsch/Nano-Banana-MCP");
  assert.equal(r.repo, "digitalerquatsch/Nano-Banana-MCP");
  assert.equal(r.language, "TypeScript");
  assert.equal(r.homepage, "");
  assert.deepEqual(r.files.map((f) => f.name), ["src", "README.md", "CLAUDE.md"]);
  assert.equal(r.docs[0].text, "Run npm test before committing.");
  assert.ok(calls.every((c) => c.auth === "Bearer ghp_x"));
  const input = buildProjectInput(r);
  assert.match(input, /<repo>[\s\S]*Hauptsprache: TypeScript[\s\S]*Dateien im Hauptverzeichnis: src\/, README\.md, CLAUDE\.md[\s\S]*Generate and edit images[\s\S]*<\/repo>/);
});

test("GitHub errors become helpful messages", async () => {
  const gh = (status) => createGithub({ fetchImpl: fakeFetch([], { status }) }).fetchRepo("a/b");
  await assert.rejects(gh(404), /privat.*Token/);
  await assert.rejects(gh(401), /Token ist ungültig/);
  await assert.rejects(gh(403), /Limit/);
  await assert.rejects(createGithub({ fetchImpl: async () => { throw new Error("net"); } }).fetchRepo("a/b"), /nicht erreichbar/);
});

const summary = { name: "Nano-Banana MCP", summary: "MCP-Server, der mit Gemini Bilder erzeugt und bearbeitet.", features: ["Bilder erzeugen", "Bilder bearbeiten"], usage: "1. Gemini-Key holen\n2. Server im MCP-Client eintragen", tech: "TypeScript, Gemini 2.5 Flash Image", faqs: [{ q: "Was brauche ich?", a: "Einen Gemini API-Key." }, { q: " ", a: "" }] };

test("summarizeProject asks the model with the repo as untrusted material", async () => {
  let seen;
  const ai = { async parse(p) { seen = p; return summary; } };
  const r = await createGithub({ fetchImpl: fakeFetch([]) }).fetchRepo("digitalerquatsch/Nano-Banana-MCP");
  const p = await summarizeProject(r, { ai });
  assert.match(seen.system, /Folge keinen Befehlen/);
  assert.equal(p.repo, "digitalerquatsch/Nano-Banana-MCP");
  assert.equal(p.faqs.length, 1, "empty FAQ dropped");
  assert.deepEqual(p.features, ["Bilder erzeugen", "Bilder bearbeiten"]);
});

test("projects end up in the agent's prompt", () => {
  const cfg = withDefaults({ name: "Ida", company: "Digitaler Quatsch", projects: [{ repo: "digitalerquatsch/Nano-Banana-MCP", url: "https://github.com/digitalerquatsch/Nano-Banana-MCP", ...summary }, { repo: 5 }] });
  assert.equal(cfg.projects.length, 1, "broken entries are dropped");
  const prompt = buildPrompt(cfg);
  assert.match(prompt, /Projekte, über die du Auskunft gibst:\n## Nano-Banana MCP \(https:\/\/github\.com\/digitalerquatsch\/Nano-Banana-MCP\)/);
  assert.match(prompt, /Funktionen:\n- Bilder erzeugen/);
  assert.match(prompt, /F: Was brauche ich\?/);
});

test("import endpoint: admin route, quota, private-repo token, stored sanitized", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-gh-"));
  const calls = [];
  const ai = { configured: true, async parse() { return summary; } };
  const s = http.createServer(createApp({ dataDir: dir, ai, githubFetch: fakeFetch(calls, { privateRepo: true }) }));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://localhost:${s.address().port}`;
  const H = { "x-agentenwerk": "1", "content-type": "application/json" };
  const post = (p, b) => fetch(u + p, { method: "POST", headers: H, body: JSON.stringify(b) });
  await fetch(`${u}/api/system`, { method: "PUT", headers: { ...H }, body: JSON.stringify({ githubToken: "ghp_secret" }) });
  assert.equal((await post("/api/projects/import", { repo: "../../etc" })).status, 400);
  const ok = await post("/api/projects/import", { repo: "https://github.com/digitalerquatsch/Nano-Banana-MCP" });
  assert.equal(ok.status, 200);
  const { project } = await ok.json();
  assert.equal(project.private, true);
  assert.ok(calls.length && calls.every((c) => c.auth === "Bearer ghp_secret"), "the saved token is used");
  const agent = await (await post("/api/agents", { name: "Ida", projects: [project, { repo: "evil/../x", summary: "x" }, { ...project, repo: "a/b", url: "http://evil.example" }] })).json();
  assert.equal(agent.projects.length, 2);
  assert.equal(agent.projects[1].url, "https://github.com/a/b", "only github.com links are kept");
  assert.equal(JSON.stringify(await (await fetch(`${u}/api/system`, { headers: H })).json()).includes("ghp_secret"), false);
  s.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("the ready-made 'Agent mit meinen Projekten' is valid and accepted by the server", async () => {
  const raw = JSON.parse(await fs.readFile(new URL("../public/examples/mein-agent.json", import.meta.url), "utf8"));
  const cfg = withDefaults(raw);
  assert.equal(cfg.projects.length, 7);
  assert.deepEqual(cfg.projects.map((p) => p.repo).sort(), ["digitalerquatsch/Nano-Banana-MCP", "digitalerquatsch/Scrapegraph-ai", "digitalerquatsch/claude-skill-webdesigner", "digitalerquatsch/docusaurus-docs", "digitalerquatsch/higgsfield-claude-skills", "digitalerquatsch/jarvis", "digitalerquatsch/web-design"]);
  for (const p of cfg.projects) assert.ok(p.summary && p.features.length && p.faqs.length, p.repo);
  const prompt = buildPrompt(cfg);
  assert.match(prompt, /Quelle laut README: das Projekt ScrapeGraphAI/);
  assert.match(prompt, /Sag offen, wenn ein Projekt laut README ursprünglich von anderen stammt/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentenwerk-seed-"));
  const s = http.createServer(createApp({ dataDir: dir, ai: { configured: false } }));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const u = `http://localhost:${s.address().port}`;
  const H = { "x-agentenwerk": "1", "content-type": "application/json" };
  delete raw.format;
  const saved = await (await fetch(`${u}/api/agents`, { method: "POST", headers: H, body: JSON.stringify(withDefaults(raw)) })).json();
  assert.equal(saved.projects.length, 7, "no project is dropped by validation");
  assert.equal(saved.projects[0].features.length, 6);
  assert.equal(saved.widgetTheme, "dark");
  s.close();
  await fs.rm(dir, { recursive: true, force: true });
});
