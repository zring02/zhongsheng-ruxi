import type { DecideInput, ModelAdapter } from '../types.js';
import { postJSON, trimBase } from './http.js';

/** 支持 output_config.effort 的模型（Opus 4.5+、4.6 系列、5.x 系列）；更老的模型传了会 400 */
const supportsEffort = (model: string) => /claude-(opus-4-[5-8]|sonnet-4-6|(opus|sonnet|haiku|fable|mythos)-5)/.test(model);

/**
 * Anthropic Claude（Messages API）。
 * claude-sonnet-5-5 这类新模型默认开着自适应思考，思考 token 算在 max_tokens 里，
 * 所以 max_tokens 要留得够大，并用 effort=low 让简单请求尽量不思考（thinking:disabled 在这些模型上会 400）。
 */
export class AnthropicAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  available() {
    return !!process.env.ANTHROPIC_API_KEY;
  }
  async decide({ agent, system, prompt, maxTokens, temperature, onUsage }: DecideInput) {
    const model = agent.model ?? 'claude-sonnet-5-5';
    const data = await postJSON(
      `${trimBase(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')}/v1/messages`,
      {
        model,
        // 思考 token 也算在 max_tokens 里，所以在回答上限之外多留一截
        max_tokens: (maxTokens ?? 400) + 1024,
        ...(supportsEffort(model) ? { output_config: { effort: 'low' } } : {}),
        ...(temperature !== undefined ? { temperature: Math.min(1, temperature) } : {}),
        system,
        messages: [{ role: 'user', content: prompt }],
      },
      { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    );
    const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (data.usage && onUsage) {
      const cached = Number(data.usage.cache_read_input_tokens) || 0;
      onUsage({ provider: 'anthropic', model, promptTokens: (Number(data.usage.input_tokens) || 0) + cached + (Number(data.usage.cache_creation_input_tokens) || 0), cachedTokens: cached, completionTokens: Number(data.usage.output_tokens) || 0 });
    }
    if (data.stop_reason === 'refusal') throw new Error(`模型拒绝回答(${data.stop_details?.category ?? 'refusal'})`);
    if (data.stop_reason === 'max_tokens' && !text.trim()) throw new Error('模型输出被截断(max_tokens)，思考占满了额度');
    return text;
  }
}
