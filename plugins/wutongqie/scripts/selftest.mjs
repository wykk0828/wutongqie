// 离线自检：不调模型，只验证"压缩段抽取 + 渲染"是否正确。
//   node scripts/selftest.mjs                 跑默认用例
//   node scripts/selftest.mjs <sessionId>     指定会话
//   node scripts/selftest.mjs --render        额外把第 1 段渲染结果打到 stdout
import { getSource } from "../core/sources/index.mjs";
import { releaseDb } from "../core/sources/zcode.mjs";
import { renderSegment } from "../core/render.mjs";
import { loadConfig } from "../core/config.mjs";

const args = process.argv.slice(2);
const wantRender = args.includes("--render");
const sessionId = args.find((a) => !a.startsWith("--"));
const cfg = loadConfig();
const source = getSource("zcode");

const session = sessionId ? source.getSession(sessionId) : pickSessionWithMostCompactions();
if (!session) {
  console.error("没有可用的会话");
  process.exit(1);
}

function pickSessionWithMostCompactions() {
  for (const s of source.listSessions({ limit: 60 })) {
    const n = source.listCompactions(s.id).length;
    if (n >= 3) return s;
  }
  return source.listSessions({ limit: 1 })[0] ?? null;
}

console.log(`会话: ${session.title}`);
console.log(`  id=${session.id}`);
console.log(`  cwd=${session.cwd}`);

const comps = source.listCompactions(session.id);
console.log(`\n有效压缩边界: ${comps.length} 条`);
for (const [i, c] of comps.entries()) {
  const fromSeq = i === 0 ? -1 : comps[i - 1].tailSequence - 1;
  const span = c.tailSequence - fromSeq - 1;
  console.log(
    `  #${i + 1} ${c.time} trigger=${c.trigger} phase=${c.phase} ` +
      `token ${c.preCompactTokenCount}->${c.postCompactTokenCount} ` +
      `压缩掉 ${c.summarizedMessageCount} 条模型输入消息 | 本段序列 [${fromSeq + 1}, ${c.tailSequence - 1}] 共 ${span} 行 ` +
      `官方摘要 ${c.officialSummary ? c.officialSummary.length + " 字符" : "无"}`,
  );
  if (span < 0) console.log(`    ⚠️ 段为空（尾巴序号未递增，可能有异常压缩）`);
}

// 校验 1：每次压缩的尾巴序号必须严格递增
let ok = true;
for (let i = 1; i < comps.length; i++) {
  if (comps[i].tailSequence <= comps[i - 1].tailSequence) {
    ok = false;
    console.log(`  ⚠️ #${i + 1} 尾巴序号未递增: ${comps[i - 1].tailSequence} -> ${comps[i].tailSequence}`);
  }
}
console.log(`\n[校验] 尾巴序号严格递增: ${ok ? "通过" : "不通过"}`);

// 校验 2：段内消息里 kind 分布应当只有白名单 + official-summary
const first = comps[0];
if (first) {
  const fromSeq = -1;
  const seg = source.getSegment(session.id, fromSeq, first.tailSequence);
  const kinds = {};
  for (const m of seg.messages) kinds[m.special || m.kind] = (kinds[m.special || m.kind] ?? 0) + 1;
  console.log(`[校验] 第 1 段 kind 分布:`, kinds);
  const md = renderSegment(seg, { maxMessageChars: cfg.maxMessageChars, withToolOutput: false });
  const rawMd = renderSegment(seg, { maxMessageChars: 999999, withToolOutput: true });
  console.log(`[校验] 渲染后长度: 紧凑版 ${md.length} 字符 / 原文版 ${rawMd.length} 字符`);

  if (wantRender) {
    console.log("\n================ 紧凑版渲染（前 6000 字符） ================\n");
    console.log(md.slice(0, 6000));
  }
}

// 校验 3：活跃尾巴
const maxSeq = source.maxSequence(session.id);
const lastTail = comps.length ? comps.at(-1).tailSequence - 1 : -1;
console.log(`\n[校验] 活跃尾巴: sequence ${lastTail + 1}..${maxSeq} 共 ${maxSeq - lastTail} 行`);
if (comps.length) {
  const live = source.getSegment(session.id, lastTail, maxSeq + 1);
  console.log(`[校验] 活跃段取到 ${live.messages.length} 条消息, 工具调用 ${live.stats.toolCount} 次`);
}

releaseDb();
console.log("\n自检完成。");
