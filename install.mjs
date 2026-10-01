// 把插件注册到 ZCode（写入 ~/.zcode/cli/config.json 的 plugins.dirs）。幂等：重复执行不会产生重复条目。
// 只写注册目录，不下载、不安装、不重启宿主；重启由用户自己操作。
//   node install.mjs            注册
//   node install.mjs --uninstall  注销
//   node install.mjs --check      只检查状态
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "wutongqie");
const CONFIG = join(homedir(), ".zcode", "cli", "config.json");

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const check = args.includes("--check");

function readConfig() {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  } catch (err) {
    console.error(`读不了 ${CONFIG}: ${err.message}`);
    process.exit(1);
  }
}

function writeConfig(cfg) {
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

const MANIFEST = join(PLUGIN_DIR, ".zcode-plugin", "plugin.json");
if (!existsSync(MANIFEST)) {
  console.error(`插件清单不存在: ${PLUGIN_DIR}`);
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (err) {
  console.error(`插件清单解析失败 ${MANIFEST}: ${err.message}`);
  process.exit(1);
}

const cfg = readConfig();
cfg.plugins ??= {};
cfg.plugins.enabled ??= true;
cfg.plugins.dirs ??= [];

const normalized = resolve(PLUGIN_DIR);
const current = cfg.plugins.dirs.map((d) => resolve(d));
const idx = current.indexOf(normalized);

if (check) {
  console.log(`配置文件: ${CONFIG}`);
  console.log(`插件目录:  ${PLUGIN_DIR}`);
  console.log(`插件版本:  ${manifest.version ?? "(清单里没有版本)"}`);
  console.log(`已注册:    ${idx >= 0 ? "是" : "否"}`);
  console.log(`当前 plugins.dirs:`);
  for (const d of cfg.plugins.dirs) console.log(`  - ${d}`);
  process.exit(idx >= 0 ? 0 : 1);
}

if (uninstall) {
  if (idx < 0) {
    console.log("未注册，无需注销。");
  } else {
    cfg.plugins.dirs.splice(idx, 1);
    writeConfig(cfg);
    console.log(`已注销。重启 ZCode 后生效。`);
  }
  process.exit(0);
}

if (idx >= 0) {
  console.log(`已注册（插件版本 ${manifest.version}），无需重复添加:\n  ${PLUGIN_DIR}`);
  console.log("\n重启 ZCode 后生效。");
  process.exit(0);
}

cfg.plugins.dirs.push(PLUGIN_DIR);
writeConfig(cfg);
console.log(`已写入 ${CONFIG}:`);
console.log(JSON.stringify(cfg.plugins, null, 2));
console.log("\n重启 ZCode 后生效。生效后：");
console.log("  · 平时照常工作：每次上下文压缩都会在后台自动归档，不需要任何操作");
console.log("  · 准备换会话时，说「我要换会话」或用 /change：立即拿到可复制的交接（内容没变化就直接复用最新交接），不用等");
console.log("  · 有新内容时先给可复制的草稿，后台继续完善同一份交接文档，完成后下一轮对话自动播报最终版");
console.log("  · 把开场提示复制到新会话，就能接着之前的工作继续");
console.log("  · 其他用法：/change 面板 /change 历史 /change 状态");
