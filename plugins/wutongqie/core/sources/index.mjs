// AgentSource 注册表。新增一个 agent（比如 Codex）只需在这里注册一个实现，
// 归档引擎（core/archive.mjs）不需要任何改动。契约见同目录 ADAPTER.md。
import { zcodeSource } from "./zcode.mjs";

const SOURCES = new Map([[zcodeSource.id, zcodeSource]]);

export function registerSource(source) {
  SOURCES.set(source.id, source);
  return source;
}

export function getSource(id) {
  const key = id || "zcode";
  const s = SOURCES.get(key);
  if (!s) throw new Error(`未知的会话源: ${key}（已注册: ${[...SOURCES.keys()].join(", ")}）`);
  return s;
}

export function listSources() {
  return [...SOURCES.values()].map((s) => ({ id: s.id, name: s.name }));
}
