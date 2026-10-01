// 验证 provider 挑选与真实调用：node scripts/llmtest.mjs [--full]
import { listProviders, pickProvider, complete } from "../core/llm.mjs";
import { loadConfig } from "../core/config.mjs";

const cfg = loadConfig();
console.log("== 可用 provider 列表（密钥已掩码）==");
for (const p of listProviders()) {
  console.log(
    `  ${p.usable ? "✔" : "✖"} ${p.name.padEnd(18)} ${p.providerId.slice(0, 8)}…  ` +
      `api=${p.apiType ?? "-"}  url=${p.baseUrl}  key=${p.keyHint || "无"}  models=${p.models.join(",") || "-"}` +
      `${p.enabled ? "" : "  [disabled]"}`,
  );
}

const chosen = pickProvider({ providerId: cfg.llmProviderId, modelId: cfg.llmModelId });
console.log(`\n== 选中 ==\n  ${chosen.name} / ${chosen.modelId}  →  ${chosen.baseUrl}/chat/completions`);

console.log("\n== 发一次真实请求 ==");
const t0 = Date.now();
try {
  const r = await complete(
    [
      { role: "system", content: "你是一个只做连通性测试的助手。只回复一句话，不要多余内容。" },
      { role: "user", content: "回复「连通正常」四个字即可。" },
    ],
    { providerId: cfg.llmProviderId, modelId: cfg.llmModelId, timeoutMs: 60000, fallback: false },
  );
  console.log(`  ✔ ${(Date.now() - t0) / 1000}s  model=${r.modelId}  usage=${JSON.stringify(r.usage)}`);
  console.log(`  回复: ${r.text.slice(0, 200)}`);
} catch (err) {
  console.error(`  ✖ 失败: ${err.message}`);
  process.exitCode = 1;
}
