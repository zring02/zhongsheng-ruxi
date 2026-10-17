import type { AgentConfig, DecideInput, ModelAdapter } from '../types.js';
import { postJSON, trimBase } from './http.js';

/** OpenAI 兼容接口的预设：国产模型全部走这一个适配器，只是地址和 key 的环境变量名不同 */
export const OPENAI_COMPAT_PRESETS: Record<string, { label: string; baseUrl: string; apiKeyEnv: string; baseUrlEnv: string; defaultModel: string; extraBody?: Record<string, unknown> }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', defaultModel: 'gpt-4.1-mini' },
  // DeepSeek 2026-10 起默认开思考模式（慢、贵），这个游戏只用非推理回答，所以请求里显式关掉；models.json 的 extraBody 可以覆盖
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL', defaultModel: 'deepseek-flash', extraBody: { thinking: { type: 'disabled' } } },
  doubao: { label: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'ARK_API_KEY', baseUrlEnv: 'ARK_BASE_URL', defaultModel: 'doubao-1-5-lite-32k-250115' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', baseUrlEnv: 'DASHSCOPE_BASE_URL', defaultModel: 'qwen-turbo' },
  kimi: { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', baseUrlEnv: 'MOONSHOT_BASE_URL', defaultModel: 'moonshot-v1-8k' },
  zhipu: { label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', baseUrlEnv: 'ZHIPU_BASE_URL', defaultModel: 'glm-4-flash' },
};

/**
 * key / base url 的解析规则（防止把一家的 key 发到另一家的地址）：
 * - 角色配了 apiKeyEnv 就只读那个变量，缺失就视为不可用，绝不回退到预设的 key；
 * - 角色配了 baseUrlEnv 就只读那个变量；没配 apiKeyEnv 的话请求不带 key（本地 vLLM / LM Studio 这类服务）；
 * - 都没配：地址用 预设的 *_BASE_URL 环境变量 或 预设默认地址，key 用预设的环境变量（如 DEEPSEEK_API_KEY）。
 */
function resolveEndpoint(provider: string, cfg: AgentConfig): { baseUrl: string | undefined; key: string | undefined; missing: string | null } {
  const preset = OPENAI_COMPAT_PRESETS[provider] ?? OPENAI_COMPAT_PRESETS.openai;
  const baseUrl = cfg.baseUrlEnv ? process.env[cfg.baseUrlEnv] : process.env[preset.baseUrlEnv] || preset.baseUrl;
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : cfg.baseUrlEnv ? undefined : process.env[preset.apiKeyEnv];
  let missing: string | null = null;
  if (cfg.apiKeyEnv && !key) missing = cfg.apiKeyEnv;
  else if (cfg.baseUrlEnv && !baseUrl) missing = cfg.baseUrlEnv;
  else if (!key && !cfg.baseUrlEnv) missing = preset.apiKeyEnv;
  return { baseUrl, key, missing };
}

/**
 * OpenAI Chat Completions 及所有兼容它的服务（DeepSeek、豆包、通义千问、Kimi、智谱……）。
 * 每个预设注册成一个 provider（见 adapters/index.ts），models.json 里写 provider 名就行。
 */
export class OpenAIAdapter implements ModelAdapter {
  constructor(readonly provider: string = 'openai') {}
  available(agent?: AgentConfig) {
    const preset = OPENAI_COMPAT_PRESETS[this.provider] ?? OPENAI_COMPAT_PRESETS.openai;
    if (!agent) return !!process.env[preset.apiKeyEnv];
    return resolveEndpoint(this.provider, agent).missing === null;
  }
  async decide({ agent, system, prompt, maxTokens, json, temperature, onUsage }: DecideInput) {
    const preset = OPENAI_COMPAT_PRESETS[this.provider] ?? OPENAI_COMPAT_PRESETS.openai;
    const { baseUrl, key, missing } = resolveEndpoint(this.provider, agent);
    if (missing || !baseUrl) throw new Error(`缺少环境变量 ${missing ?? agent.baseUrlEnv}`);
    // JSON 模式要求提示词里出现 json 这个词（DeepSeek 等会直接报错），模板都写了“只输出 JSON”，这里兜一下
    const wantJSON = json !== false;
    const userPrompt = wantJSON && !/json/i.test(system + prompt) ? `${prompt}\n只输出 json。` : prompt;
    const data = await postJSON(
      `${trimBase(baseUrl)}/chat/completions`,
      {
        ...(preset.extraBody ?? {}),
        ...(agent.extraBody ?? {}),
        model: agent.model ?? preset.defaultModel,
        max_tokens: maxTokens ?? 400,
        temperature: temperature ?? 0.9,
        ...(wantJSON ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      },
      key ? { authorization: `Bearer ${key}` } : {},
    );
    const u = data.usage;
    if (u && onUsage) {
      // DeepSeek 用 prompt_cache_hit_tokens，OpenAI/豆包/千问用 prompt_tokens_details.cached_tokens
      const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
      // DeepSeek 开着思考时 completion_tokens 含思考 token（我们已关掉，但保险起见仍按总数计费）
      onUsage({ provider: this.provider, model: agent.model ?? preset.defaultModel, promptTokens: Number(u.prompt_tokens) || 0, cachedTokens: cached, completionTokens: Number(u.completion_tokens) || 0 });
    }
    const msg = data.choices?.[0]?.message;
    // 个别服务把 JSON 放在 content 以外（或 content 为空、只给了 reasoning_content）：content 为空就当失败，让上层重试
    return typeof msg?.content === 'string' ? msg.content : '';
  }
}
