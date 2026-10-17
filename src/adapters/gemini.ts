import type { DecideInput, ModelAdapter } from '../types.js';
import { postJSON, trimBase } from './http.js';

/**
 * Google Gemini（generateContent）。
 * Gemini 2.5 系列默认开着思考，而且思考 token 算在 maxOutputTokens 里：
 * flash / flash-lite 可以把 thinkingBudget 设成 0 关掉；pro 关不掉，只能给个最小预算并把输出上限放大。
 */
export class GeminiAdapter implements ModelAdapter {
  readonly provider = 'gemini';
  available() {
    return !!process.env.GEMINI_API_KEY;
  }
  async decide({ agent, system, prompt, maxTokens, json, temperature, onUsage }: DecideInput) {
    const model = agent.model ?? 'gemini-2.5-flash';
    const thinkingBudget = /pro/.test(model) ? 128 : 0;
    const data = await postJSON(
      `${trimBase(process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com')}/v1beta/models/${model}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { ...(json === false ? {} : { responseMimeType: 'application/json' }), ...(temperature !== undefined ? { temperature } : {}), maxOutputTokens: (maxTokens ?? 400) + thinkingBudget + 256, thinkingConfig: { thinkingBudget } },
      },
      { 'x-goog-api-key': process.env.GEMINI_API_KEY! },
    );
    const blocked = data.promptFeedback?.blockReason;
    if (blocked) throw new Error(`模型拒绝回答(${blocked})`);
    const um = data.usageMetadata;
    if (um && onUsage) onUsage({ provider: 'gemini', model, promptTokens: Number(um.promptTokenCount) || 0, cachedTokens: Number(um.cachedContentTokenCount) || 0, completionTokens: (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0) });
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    if (cand && cand.finishReason && cand.finishReason !== 'STOP' && !text.trim()) {
      throw new Error(cand.finishReason === 'MAX_TOKENS' ? '模型输出被截断(MAX_TOKENS)，思考占满了额度' : `模型没有给出回答(${cand.finishReason})`);
    }
    return text;
  }
}
