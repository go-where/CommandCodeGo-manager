// 请求遥测:in-memory pub/sub(Admin SSE 实时日志消费)+ 异步落库
// (requests 表 + usage_daily 聚合)。纪律:
//   - 记录全程 try/catch,遥测失败绝不影响代理;
//   - 不落消息正文;不落任何明文 key(仅 key 名称/掩码/内部 id)。
import { insertRequest } from './store/requests.mjs';
import { recordUsage } from './store/usage.mjs';
import { log } from './log.mjs';

const subscribers = new Set();

/** 订阅实时请求事件(Admin SSE 用)。返回取消订阅函数。 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function publish(event) {
  for (const fn of subscribers) {
    try { fn(event); } catch {}
  }
}

/** 落一条请求记录(并发安全;fire-and-forget,不阻塞响应)。 */
export function recordRequest(rec) {
  Promise.resolve().then(async () => {
    try {
      await insertRequest(rec);
      if ((rec.inputTokens ?? 0) > 0 || (rec.outputTokens ?? 0) > 0 || (rec.cachedTokens ?? 0) > 0) {
        await recordUsage({
          ts: rec.ts,
          keyId: rec.clientKeyId ?? null,
          model: rec.model ?? 'unknown',
          inputTokens: rec.inputTokens ?? 0,
          outputTokens: rec.outputTokens ?? 0,
          cachedTokens: rec.cachedTokens ?? 0,
          durationMs: rec.durationMs ?? null,
          ttftMs: rec.ttftMs ?? null,
          statusCode: rec.statusCode ?? null,
        });
      }
    } catch (e) {
      log('warn', 'Telemetry persist failed', { error: e.message });
    } finally {
      // SSE 消费者收到事件后会立即查询统计,必须先完成落库。
      publish(rec);
    }
  });
}

/**
 * 请求插桩:包装 res.writeHead 捕获状态码,close 时自动记录。
 * handler 通过返回的 t 对象补充业务字段:
 *   t.model / t.stream           —— 请求解析后直接赋值
 *   t.provider()                 —— 可选,close 时调用,返回 { usage, finishReason }
 *                                   (闭包读取各分支局部变量的终值,免多处出口插点)
 * 鉴权上下文从 req.ccpAuth 读取。
 * 返回的 t 不参与控制流,未赋值的字段按缺省记录。
 *   t.noteStreamError(type)      —— 可选,SSE 流内报错(HTTP 可能已是 200)时调用,
 *                                   把该类型落进 error_type,面板才不会把失败当成功
 */
export function instrumentRequest(req, res, endpoint) {
  const startedAt = Date.now();
  const t = { model: null, stream: false, provider: null, finishReason: null, streamError: null };
  // 首个流内错误类型生效(同一次请求可能叠加多个出口,只记根因)
  t.noteStreamError = (type) => {
    if (typeof type === 'string' && type.length > 0 && t.streamError == null) t.streamError = type;
  };

  let statusCode = null;
  // 首字到达时间:首个上游事件写出前调用 t.firstTokenAt(startTime) 打点(仅记第一次)。
  let ttftMs = null;
  t.firstTokenAt = (start) => {
    if (ttftMs != null) return;
    const origin = Number.isFinite(start) ? start : startedAt;
    ttftMs = Math.max(0, Date.now() - origin);
  };
  const origWriteHead = res.writeHead;
  res.writeHead = function (status, ...rest) {
    if (statusCode == null) statusCode = status;
    return origWriteHead.call(this, status, ...rest);
  };

  res.on('close', () => {
    try {
      const auth = req.ccpAuth && !req.ccpAuth.error ? req.ccpAuth : null;
      let u = {}; let fr = t.finishReason ?? null;
      if (typeof t.provider === 'function') {
        try { const r = t.provider() || {}; u = r.usage || {}; fr = r.finishReason ?? fr; } catch {}
      }
      const rec = {
        ts: startedAt,
        endpoint,
        proxyKey: auth?.clientKeyName
          ?? (auth?.mode === 'direct' ? '(direct)' : auth?.mode === 'config' ? '(config)' : null),
        clientKeyId: auth?.clientKeyId ?? null,
        upstreamKeyId: auth?.upstreamKeyId ?? null,
        model: t.model,
        statusCode: statusCode ?? res.statusCode ?? null,
        stream: t.stream === true,
        durationMs: Date.now() - startedAt,
        // 非流式请求没有「首字」概念:整包返回耗时即用户等待时间,用它近似。
        ttftMs: ttftMs ?? (t.stream === true ? null : Date.now() - startedAt),
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cachedTokens: u.cachedInputTokens ?? u.cachedTokens ?? 0,
        finishReason: fr,
        clientDisconnected: !res.writableEnded,
      };
      if (rec.statusCode >= 400 && !rec.errorType) rec.errorType = `http_${rec.statusCode}`;
      // HTTP 已 200 但流内报错(空闲超时/零输出/截断等):状态码看不出失败,用 error_type 标注
      else if (!rec.errorType && t.streamError != null) rec.errorType = t.streamError;
      recordRequest(rec);
    } catch (e) {
      log('warn', 'Telemetry instrument failed', { error: e.message });
    }
  });

  return t;
}
