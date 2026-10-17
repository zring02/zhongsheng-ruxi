/** 去掉 base URL 末尾的斜杠，避免拼出 /v1//chat/completions 这种路径 */
export const trimBase = (base: string) => base.replace(/\/+$/, '');

/** 抹掉像 key 的串（sk-…、Bearer …、URL 里的 key=…），报错文字、日志、调用记录都过一遍 */
export function redactSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9_.\-]{8,}/gi, 'Bearer ***')
    .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1***');
}

/** 从上游返回的错误正文里挑出一句能看的说明（各家 JSON 都有 error.message / error.type 之类字段） */
function summarizeErrorBody(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    const msg = e?.message ?? e?.msg ?? j?.message;
    const type = e?.type ?? e?.code ?? e?.status;
    if (typeof msg === 'string' && msg) return redactSecrets(`${type ? `${type}: ` : ''}${msg.slice(0, 160)}`);
    if (typeof type === 'string') return redactSecrets(type);
  } catch {
    /* 不是 JSON */
  }
  return '';
}

/**
 * 适配器共用的 fetch 封装：超时 + 非 2xx 抛错。
 * - 网络错误把 err.cause（ECONNREFUSED / ENOTFOUND / 证书问题等）带进消息里，不然只剩一句 fetch failed；
 * - 上游错误正文完整打到服务端日志，抛给调用方（最终会广播到所有前端）的只保留状态码和一句说明，
 *   避免把带着 key 片段、内部网关信息的原文展示给所有观众。
 */
/** 单次模型调用的超时（毫秒）：环境变量 MODEL_TIMEOUT_MS，默认 60 秒。接口排队严重时可以调大；超时算一次失败，角色连续失败几次会临时改用内置 mock */
export const modelTimeoutMs = () => {
  const n = Number(process.env.MODEL_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 60_000;
};

export async function postJSON(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = modelTimeoutMs()): Promise<any> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 非法 URL 让 fetch 自己报错 */
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`请求 ${host} 超时（${Math.round(timeoutMs / 1000)} 秒，可用 MODEL_TIMEOUT_MS 调大）`);
    const cause = err.cause?.message ? ` (${err.cause.message})` : '';
    throw new Error(`请求 ${host} 失败: ${err.message}${cause}`);
  }
  // 正文也可能等很久（有的服务先回 200 再慢慢排队、只发空行保活），同样受超时约束
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`请求 ${host} 等正文超时（${Math.round(timeoutMs / 1000)} 秒，可用 MODEL_TIMEOUT_MS 调大）`);
    throw new Error(`读取 ${host} 的回应失败: ${err.message}`);
  }
  if (!res.ok) {
    console.error(`[http] ${host} 返回 HTTP ${res.status}: ${redactSecrets(text.slice(0, 1000))}`);
    const summary = summarizeErrorBody(text);
    throw new Error(`${host} 返回 HTTP ${res.status}${summary ? `: ${summary}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${host} 返回的不是 JSON（前 80 字：${redactSecrets(text.trim().slice(0, 80))}）`);
  }
}
