import type { AgentConfig, ModelAdapter } from '../types.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { MockAdapter } from './mock.js';
import { OllamaAdapter } from './ollama.js';
import { OPENAI_COMPAT_PRESETS, OpenAIAdapter } from './openai.js';

/** 适配器注册表。接新模型 = 写一个实现 ModelAdapter 的类，在这里注册；OpenAI 兼容的服务只要在 openai.ts 加一条预设 */
const ADAPTERS: Record<string, ModelAdapter> = {
  ...Object.fromEntries(Object.keys(OPENAI_COMPAT_PRESETS).map((p) => [p, new OpenAIAdapter(p)])),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  ollama: new OllamaAdapter(),
  mock: new MockAdapter(),
};

export const PROVIDERS = Object.keys(ADAPTERS);
export const isKnownProvider = (provider: string) => provider in ADAPTERS;

/**
 * 按角色配置取适配器；不可用（没 key / 缺环境变量）时降级到 mock，保证能跑起来。
 * reason 说明为什么降级：'unknown' = provider 拼错，'unavailable' = 缺 key 或所需环境变量
 */
export function resolveAdapter(config: AgentConfig): { adapter: ModelAdapter; fallback: boolean; reason: 'unknown' | 'unavailable' | null } {
  const a = ADAPTERS[config.provider];
  if (!a) return { adapter: ADAPTERS.mock, fallback: true, reason: 'unknown' };
  if (a.available(config)) return { adapter: a, fallback: false, reason: null };
  return { adapter: ADAPTERS.mock, fallback: config.provider !== 'mock', reason: 'unavailable' };
}
