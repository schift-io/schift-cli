import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, extname, basename } from "node:path";
import { getApiKey, getApiUrl } from "../config.js";

const MEMORY_ROOT = join(homedir(), ".schift", "memory");
const SUPPORTED_EXT = new Set([".md", ".txt", ".pdf", ".html", ".json", ".csv", ".rst", ".adoc"]);

function requireKey(): { key: string; url: string } {
  const key = getApiKey();
  if (!key) {
    console.error("  Not logged in. Run: schift auth login");
    process.exit(1);
  }
  return { key, url: getApiUrl() };
}

async function api(auth: { key: string; url: string }, path: string, body: Record<string, unknown>) {
  const resp = await fetch(`${auth.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err}`);
  }
  return resp.json();
}

function searchLocal(query: string, topK = 10, domain?: string) {
  const dirs = ["compact/session", "sources/web", "sources/search", "sources/external"];
  const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 1);
  const results: { file: string; score: number; meta: Record<string, string>; snippet: string; modified: string }[] = [];

  for (const dir of dirs) {
    const fullDir = join(MEMORY_ROOT, dir);
    let files: string[];
    try { files = readdirSync(fullDir); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(fullDir, file);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        const content = readFileSync(filePath, "utf-8");

        if (domain) {
          const m = content.match(/^domain:\s*(.+)$/m);
          if (m && m[1].trim() !== domain) continue;
        }

        const lower = content.toLowerCase();
        let score = 0;
        for (const kw of keywords) if (lower.includes(kw)) score++;
        if (score === 0) continue;

        const meta: Record<string, string> = {};
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        if (fm) for (const line of fm[1].split("\n")) {
          const [k, ...v] = line.split(":");
          if (k && v.length) meta[k.trim()] = v.join(":").trim();
        }

        const body = content.replace(/^---[\s\S]*?---\n?/, "").trim();
        results.push({ file: filePath, score, meta, snippet: body.slice(0, 300), modified: stat.mtime.toISOString() });
      } catch { continue; }
    }
  }

  results.sort((a, b) => b.score - a.score || new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return results.slice(0, topK);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}

function stripFlags(argv: string[], flags: string[]): string {
  const skip = new Set<number>();
  for (const flag of flags) {
    const idx = argv.indexOf(flag);
    if (idx !== -1) { skip.add(idx); skip.add(idx + 1); }
  }
  for (const flag of ["--offline", "--local"]) {
    const idx = argv.indexOf(flag);
    if (idx !== -1) skip.add(idx);
  }
  return argv.filter((_, i) => !skip.has(i)).join(" ");
}

export async function remember(argv: string[]) {
  const text = stripFlags(argv, ["--domain"]);
  if (!text) { console.error("  Usage: schift remember \"your note\""); process.exit(1); }

  const auth = requireKey();
  const domain = parseFlag(argv, "--domain") || "business";
  const noteId = `note_${Date.now()}`;
  const noteDir = join(MEMORY_ROOT, "compact", "session");
  mkdirSync(noteDir, { recursive: true });

  const filePath = join(noteDir, `${noteId}.md`);
  writeFileSync(filePath, `---\nsession_id: ${noteId}\ndate: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}\ndomain: ${domain}\nsynced: false\n---\n\n# Note\n\n${text}\n`);

  try {
    await api(auth, "/v1/memory/compact", { session_id: noteId, summary: text, domain });
    const content = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, content.replace("synced: false", "synced: true"));
    console.log(`  Saved: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
    console.log(`  Domain: ${domain}`);
  } catch (e) {
    console.log(`  Saved locally (sync failed: ${(e as Error).message.slice(0, 60)})`);
  }
}

export async function search(argv: string[]) {
  const query = stripFlags(argv, ["--domain"]);
  if (!query) { console.error("  Usage: schift search \"query\""); process.exit(1); }

  const auth = getApiKey() ? requireKey() : null;
  const domain = parseFlag(argv, "--domain");
  const offline = argv.includes("--offline") || argv.includes("--local");

  if (offline || !auth) {
    const results = searchLocal(query, 5, domain);
    if (!results.length) { console.log("  No local results."); return; }
    console.log(`  ${results.length} local result(s):\n`);
    for (const r of results) {
      console.log(`  [${r.meta.domain || "?"}] ${r.meta.title || r.meta.session_id || basename(r.file, ".md")}`);
      console.log(`  ${r.snippet.slice(0, 120)}...\n`);
    }
    if (!auth) console.log("  (offline - login for cloud search)");
    return;
  }

  try {
    const result = await api(auth, "/v1/query", {
      query, collection: "localbucket", top_k: 5,
      ...(domain ? { filter: { domain } } : {}),
    }) as { results?: Array<{ metadata?: Record<string, string>; score?: number; text?: string; content?: string }> };

    const hits = result.results || [];
    if (!hits.length) { console.log("  No results."); return; }
    console.log(`  ${hits.length} result(s):\n`);
    for (const h of hits) {
      const m = h.metadata || {};
      const title = m.title || m.session_id || m.topic || "untitled";
      const score = h.score != null ? ` (${(h.score * 100).toFixed(0)}%)` : "";
      const snippet = (h.text || h.content || m.summary || "").slice(0, 120);
      console.log(`  [${m.domain || "?"}] ${title}${score}`);
      if (snippet) console.log(`  ${snippet}...\n`);
    }
  } catch (e) {
    console.log(`  Cloud failed: ${(e as Error).message.slice(0, 60)}`);
    console.log("  Falling back to local...\n");
    const results = searchLocal(query, 5, domain);
    for (const r of results) {
      console.log(`  [${r.meta.domain || "?"}] ${r.meta.title || basename(r.file, ".md")}`);
      console.log(`  ${r.snippet.slice(0, 120)}...\n`);
    }
  }
}

export async function ask(argv: string[]) {
  const question = stripFlags(argv, ["--domain"]);
  if (!question) { console.error("  Usage: schift ask \"question\""); process.exit(1); }

  const auth = requireKey();

  let context = "";
  try {
    const result = await api(auth, "/v1/query", { query: question, collection: "localbucket", top_k: 3 }) as {
      results?: Array<{ metadata?: Record<string, string>; text?: string; content?: string }>;
    };
    context = (result.results || []).map((h) => {
      const m = h.metadata || {};
      return `[${m.domain || ""}] ${m.title || m.session_id || ""}\n${h.text || h.content || m.summary || ""}`;
    }).join("\n---\n");
  } catch {
    const local = searchLocal(question, 3);
    context = local.map((r) => `[${r.meta.domain || ""}] ${r.meta.title || ""}\n${r.snippet}`).join("\n---\n");
  }

  if (!context.trim()) { console.log("  No relevant knowledge found."); return; }

  try {
    const result = await api(auth, "/v1/memory/ask", { question, context }) as { answer?: string; response?: string };
    console.log(`\n  ${result.answer || result.response || JSON.stringify(result)}\n`);
  } catch {
    console.log("  (RAG endpoint not available - showing search results)\n");
    console.log(`  Q: ${question}\n`);
    console.log(`  ${context.slice(0, 800)}\n`);
  }
}

export async function ingest(argv: string[]) {
  const target = stripFlags(argv, ["--domain"]);
  if (!target) { console.error("  Usage: schift ingest ./path"); process.exit(1); }

  const auth = requireKey();
  const domain = parseFlag(argv, "--domain") || "reference";
  const fullPath = resolve(target);

  let stat;
  try { stat = statSync(fullPath); } catch { console.error(`  Not found: ${fullPath}`); process.exit(1); }

  const files: string[] = [];
  if (stat.isFile()) {
    files.push(fullPath);
  } else if (stat.isDirectory()) {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (SUPPORTED_EXT.has(extname(p).toLowerCase())) files.push(p);
      }
    };
    walk(fullPath);
  }

  if (!files.length) {
    console.log(`  No supported files in ${fullPath}`);
    console.log(`  Supported: ${[...SUPPORTED_EXT].join(", ")}`);
    return;
  }

  console.log(`  ${files.length} file(s) to ingest.\n`);
  let ok = 0, fail = 0;

  for (const file of files) {
    const name = basename(file);
    try {
      const content = readFileSync(file, "utf-8").slice(0, 50000);
      await api(auth, "/v1/memory/compact", {
        session_id: `ingest_${Date.now()}_${name}`,
        summary: `# ${name}\n\n${content}`,
        domain,
        topic: basename(file, extname(file)),
      });
      ok++;
      console.log(`  [${ok}/${files.length}] ${name}`);
    } catch (e) {
      fail++;
      console.log(`  [FAIL] ${name}: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  console.log(`\n  Done: ${ok} ingested, ${fail} failed.`);
}
