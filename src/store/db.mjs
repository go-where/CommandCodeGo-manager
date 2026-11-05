// SQLite 存储层(node:sqlite,Node ≥22.5 内置,零外部依赖)。
// 库文件:{dataDir}/ccp.db。失败降级:DB 不可用时 keys 走内存(不持久化)、
// requests/usage 丢弃,代理的 user_* 直通模式不受影响。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir, CFG } from '../config.mjs';
import { log } from '../log.mjs';

let db = null;
let degraded = false;
// 内存降级容器(keys.mjs / settings.mjs 在 getDb() 为 null 时使用)
export const memoryFallback = { upstreamKeys: new Map(), clientKeys: new Map(), settings: new Map(), nextId: 1 };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS upstream_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS client_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  upstream_key_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  proxy_key TEXT,
  upstream_key_id INTEGER,
  model TEXT,
  status_code INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  error_type TEXT,
  client_disconnected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  key_id INTEGER,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  -- 耗时/首字统计:仅计入成功请求(status 200 且有真实耗时),
  -- 均值 = sum / count;count 同时也是「有观测数据的请求数」。
  duration_ms_sum INTEGER NOT NULL DEFAULT 0,
  duration_count INTEGER NOT NULL DEFAULT 0,
  ttft_ms_sum INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key_id, model)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function init() {
  try {
    db = new DatabaseSync(join(dataDir, 'ccp.db'));
    db.exec(SCHEMA);
    migrate();
  } catch (e) {
    degraded = true;
    db = null;
    log('error', 'SQLite init failed, degrading to memory (keys not persisted)', { error: e.message });
  }
}
init();

/**
 * 幂等迁移:老库补列 + 用 requests 历史反推耗时/首字统计。
 * 回填只写 duration_count = 0 的聚合行,重复启动不会重复累加,
 * 也不会覆盖升级后新请求已累积的观测值。
 * 口径:整体耗时取全部成功的流式/非流式请求;首字时间历史无记录,
 * 只能用非流式请求的 duration 近似(非流式返回即结束),流式历史缺首字。
 */
function migrate() {
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(usage_daily)').all().map((c) => c.name));
    const add = [
      ['duration_ms_sum', 'INTEGER NOT NULL DEFAULT 0'],
      ['duration_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['ttft_ms_sum', 'INTEGER NOT NULL DEFAULT 0'],
      ['ttft_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of add) {
      if (!cols.has(name)) db.exec(`ALTER TABLE usage_daily ADD COLUMN ${name} ${type}`);
    }
    backfillSpeedStats();
  } catch (e) {
    // 迁移失败只影响速度统计,不能让整个存储降级(键会丢)。
    log('warn', 'usage_daily migrate failed', { error: e.message });
  }
}

/** 从 requests 反推耗时/首字并写入尚无观测的聚合行(仅更新,不新建行)。 */
function backfillSpeedStats() {
  const hasRequests = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'").get();
  if (!hasRequests) return;
  const keyIdByName = new Map();
  for (const c of db.prepare('SELECT id, name FROM client_keys').all()) {
    if (c.name != null) keyIdByName.set(String(c.name), c.id);
  }
  // day 口径与 usage.mjs 的 dayStr() 一致(本地时区)。
  const groups = db.prepare(`
    SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
      COALESCE(proxy_key, '(direct)') AS key_name,
      COALESCE(model, 'unknown') AS model,
      SUM(duration_ms) AS dur_sum, COUNT(*) AS dur_count,
      SUM(CASE WHEN stream = 0 THEN duration_ms ELSE 0 END) AS ttft_sum,
      SUM(CASE WHEN stream = 0 THEN 1 ELSE 0 END) AS ttft_count
    FROM requests
    WHERE status_code = 200 AND duration_ms IS NOT NULL AND duration_ms > 0
    GROUP BY day, key_name, model`).all();
  if (groups.length === 0) return;
  const upd = db.prepare(`
    UPDATE usage_daily
    SET duration_ms_sum = ?, duration_count = ?, ttft_ms_sum = ?, ttft_count = ?
    WHERE day = ? AND key_id = ? AND model = ? AND duration_count = 0 AND requests > 0`);
  let filled = 0;
  for (const g of groups) {
    const keyId = g.key_name === '(direct)' || g.key_name === '(config)'
      ? 0
      : keyIdByName.get(g.key_name);
    if (keyId == null) continue; // key 已删除/改名:无法归属,跳过
    filled += upd.run(g.dur_sum ?? 0, g.dur_count ?? 0, g.ttft_sum ?? 0, g.ttft_count ?? 0,
      g.day, keyId, g.model).changes;
  }
  if (filled > 0) log('info', 'usage_daily speed stats backfilled', { rows: filled });
}

/** 定时清理过期请求日志(保留 CFG.logRetentionDays 天)。unref:不阻止进程退出。 */
function cleanupOldRequests() {
  if (!db) return;
  try {
    const cutoff = Date.now() - Math.max(1, Number(CFG.logRetentionDays) || 30) * 86400000;
    const r = db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff);
    if (r.changes > 0) log('info', 'Request log cleanup', { deleted: r.changes });
  } catch (e) {
    log('warn', 'Request log cleanup failed', { error: e.message });
  }
}
cleanupOldRequests();
const cleanupTimer = setInterval(cleanupOldRequests, 24 * 60 * 60 * 1000);
cleanupTimer.unref?.();

export function getDb() { return db; }
export function isDegraded() { return degraded; }
export function closeDb() { try { db?.close(); } catch {} db = null; }
