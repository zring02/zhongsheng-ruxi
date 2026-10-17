import type { DecideInput, ModelAdapter } from '../types.js';
import { postJSON, trimBase } from './http.js';

/**
 * OLLAMA_HOST 是 Ollama 自己的环境变量，官方习惯写成 127.0.0.1:11434 或 0.0.0.0（没有 http://、没有端口），
 * 这里归一化成完整 URL：补 scheme、补默认端口 11434；0.0.0.0 是监听地址不能当目标，换成 127.0.0.1
 */
export function ollamaHost(): string {
  let host = process.env.OLLAMA_HOST?.trim() || 'http://localhost:11434';
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  try {
    const u = new URL(host);
    if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1';
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    host = u.href;
  } catch {
    /* 解析不了就原样交给 fetch 报错 */
  }
  return trimBase(host);
}

/** 本地 Ollama（不需要 key，只要本机跑着 ollama serve） */
export class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama';
  available() {
    return process.env.OLLAMA_ENABLED === '1' || !!process.env.OLLAMA_HOST;
  }
  async decide({ agent, system, prompt, maxTokens, json, temperature, onUsage }: DecideInput) {
    const data = await postJSON(
      `${ollamaHost()}/api/chat`,
      {
        model: agent.model ?? 'qwen2.5:7b',
        stream: false,
        ...(json === false ? {} : { format: 'json' }),
        options: { num_predict: maxTokens ?? 400, ...(temperature !== undefined ? { temperature } : {}) },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
      {},
      120_000,
    );
    if (onUsage) onUsage({ provider: 'ollama', model: agent.model ?? 'qwen2.5:7b', promptTokens: Number(data.prompt_eval_count) || 0, cachedTokens: 0, completionTokens: Number(data.eval_count) || 0 });
    return data.message?.content ?? '';
  }
}
