// 用量聚合:天 × key × model 粒度 upsert,供 /admin/api/usage 与图表查询。
import { getDb } from './db.mjs';

// 「天」用本地时区口径(与 overview 的今日统计一致);toISOString 是 UTC,
// 非 UTC 时区会在深夜把请求归到前一天。
const dayStr = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function recordUsage({
  ts, keyId, model, inputTokens = 0, outputTokens = 0, cachedTokens = 0,
  durationMs = null, ttftMs = null, statusCode = null,
}) {
  const db = getDb();
  if (!db) return;
  // 速度统计只计成功请求:失败/中断的耗时会拉偏平均值。
  const hasDuration = statusCode === 200 && Number.isFinite(durationMs) && durationMs > 0;
  const hasTtft = statusCode === 200 && Number.isFinite(ttftMs) && ttftMs >= 0;
  // key_id 用 0 表示直通/无客户端 key:SQLite 主键里 NULL 互不相等,
  // 用 NULL 会让 (day, NULL, model) 的 upsert 永不命中、每次都插新行。
  db.prepare(`
    INSERT INTO usage_daily (day, key_id, model, input_tokens, output_tokens, cached_tokens, requests,
      duration_ms_sum, duration_count, ttft_ms_sum, ttft_count)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT (day, key_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      requests = requests + 1,
      duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum,
      duration_count = duration_count + excluded.duration_count,
      ttft_ms_sum = ttft_ms_sum + excluded.ttft_ms_sum,
      ttft_count = ttft_count + excluded.ttft_count`)
    .run(dayStr(ts ?? Date.now()), keyId ?? 0, model ?? 'unknown',
      inputTokens, outputTokens, cachedTokens,
      hasDuration ? durationMs : 0, hasDuration ? 1 : 0,
      hasTtft ? ttftMs : 0, hasTtft ? 1 : 0);
}

/**
 * 聚合查询。opts: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', groupBy: 'day'|'model'|'key' }
 * groupBy=key 时附 client_keys 名称(直接落库的 usage 无 key 名,由 admin 层解析)。
 */
export async function usageSummary({ from, to, groupBy = 'day' } = {}) {
  const db = getDb();
  if (!db) return [];
  const where = [];
  const args = [];
  if (from) { where.push('day >= ?'); args.push(from); }
  if (to) { where.push('day <= ?'); args.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const dim = { day: 'day', model: 'model', key: 'key_id' }[groupBy] ?? 'day';
  const sql = `
    SELECT ${dim === 'key_id' ? `u.key_id AS key_id, CASE WHEN u.key_id = 0 THEN '(direct)' WHEN c.id IS NOT NULL THEN COALESCE(c.name, c.key_prefix) ELSE '(已删除 key #' || u.key_id || ')' END AS key_name` : `u.${dim} AS ${dim}`},
      SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
      SUM(u.cached_tokens) AS cached_tokens, SUM(u.requests) AS requests,
      SUM(u.duration_ms_sum) AS duration_ms_sum, SUM(u.duration_count) AS duration_count,
      SUM(u.ttft_ms_sum) AS ttft_ms_sum, SUM(u.ttft_count) AS ttft_count
    FROM usage_daily u
    ${dim === 'key_id' ? 'LEFT JOIN client_keys c ON c.id = u.key_id' : ''}
    ${whereSql}
    GROUP BY ${dim === 'key_id' ? 'u.key_id' : `u.${dim}`}
    ORDER BY ${dim === 'key_id' ? 'u.key_id' : `u.${dim}`}`;
  return db.prepare(sql).all(...args);
}
