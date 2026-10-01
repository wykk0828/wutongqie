// 只读 SQLite 访问。ZCode 正在写库，WAL 模式下以只读方式打开即可读到最新已提交数据。
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { ZCODE_DB } from "./config.mjs";

export function openDb(path = ZCODE_DB) {
  if (!existsSync(path)) throw new Error(`找不到 ZCode 会话库: ${path}`);
  // timeout 让并发写导致的 SQLITE_BUSY 退化为等待重试而不是立刻抛错
  const options = { readOnly: true };
  try {
    return new DatabaseSync(path, { ...options, timeout: 5000 });
  } catch {
    return new DatabaseSync(path, options);
  }
}

/**
 * 返回一个带缓存的查询函数。`q(sql, ...args)` 取多行，`q.one(sql, ...args)` 取首行。
 * 预编译语句复用，避免每次轮询都重新 prepare。
 */
export function makeQuery(db) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  const q = (sql, ...args) => prep(sql).all(...args);
  q.one = (sql, ...args) => prep(sql).get(...args);
  return q;
}

/** 进程退出前安全关闭。 */
export function closeDb(db) {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
}
