// 端到端验证：对一个真实的历史会话跑完整归档 + 总摘要。
//   node scripts/e2etest.mjs <sessionId> [--no-llm] [--output <dir>]
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSource } from "../core/sources/index.mjs";
import { releaseDb } from "../core/sources/zcode.mjs";
import { scanSession, buildTotal } from "../core/archive.mjs";
import { loadConfig } from "../core/config.mjs";
import { listProviders, pickProvider } from "../core/llm.mjs";

const args = process.argv.slice(2);
const noLlm = args.includes("--no-llm");
const outIdx = args.indexOf("--output");
const sessionId = args.find((a) => !a.startsWith("--") && a !== (outIdx >= 0 ? args[outIdx + 1] : ""));

// 输出到临时目录，不污染真实工作区（除非显式指定 --output）
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".zcode", "tests");
mkdirSync(testRoot, { recursive: true });
const tmp = outIdx >= 0 ? null : mkdtempSync(join(testRoot, "wtq-e2e-"));
const cfg = { ...loadConfig(), outputRoot: outIdx >= 0 ? args[outIdx + 1] : tmp, saveRaw: true, announce: false };

if (!noLlm) {
  const p = pickProvider({ providerId: cfg.llmProviderId, modelId: cfg.llmModelId });
  console.log(`使用模型: ${p.name} / ${p.modelId}`);
}

const source = getSource("zcode");
const session = sessionId ? source.getSession(sessionId) : source.listSessions({ limit: 50 }).find((s) => source.listCompactions(s.id).length >= 3);
if (!session) { console.error("找不到会话"); process.exit(1); }
console.log(`会话: ${session.title}`);
console.log(`压缩边界: ${source.listCompactions(session.id).length} 个\n`);

const t0 = Date.now();
console.log("== 归档压缩段 ==");
const scanned = await scanSession(session, { cwd: session.cwd, cfg, summarize: !noLlm });
console.log(`  新增 ${scanned.newCount} 段，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const c of scanned.chunks) {
  console.log(
    `  #${c.index} ${c.file}  触发=${c.trigger} token ${c.tokens}  ${c.rows}行/${c.toolCalls}次工具  ` +
      `${c.approxTokens}t  摘要=${c.summarized ? "✔ " + c.model : "✖"}`,
  );
}
if (scanned.errors.length) {
  console.log("  错误:");
  for (const e of scanned.errors) console.log(`    ! ${e.boundaryId}: ${e.error}`);
}
console.log(`  LIVE 段: ${scanned.live ? `sequence ${scanned.live.fromSeq}..${scanned.live.toSeq}, ${scanned.live.rows}行` : "无"}`);

const root = scanned.paths.root;
console.log(`\n产出目录: ${root}`);
function tree(dir, indent = "  ") {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${indent}${entry.name}/`);
      tree(p, indent + "  ");
    } else {
      console.log(`${indent}${entry.name}  ${readFileSync(p, "utf8").length} 字符`);
    }
  }
}
tree(join(root, "sessions"));

if (!noLlm) {
  console.log("\n== 生成总摘要 ==");
  const t1 = Date.now();
  const total = await buildTotal({ sessionOrId: session.id, cwd: session.cwd, cfg });
  console.log(`  ✔ ${((Date.now() - t1) / 1000).toFixed(1)}s  合并 ${total.chunkCount} 段 / ${total.passes} 轮  ${total.model}`);
  console.log(`  token: ${JSON.stringify(total.usage)}`);
  console.log(`  路径: ${total.path}`);
  console.log("\n---------------- TOTAL.md 前 3000 字符 ----------------\n");
  console.log(readFileSync(total.path, "utf8").slice(0, 3000));
}

if (tmp) {
  console.log(`\n(临时目录保留以便检查: ${tmp})`);
  console.log(`删除: rm -rf "${tmp}"`);
}
releaseDb();
