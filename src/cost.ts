import type { ModelCatalog } from './models.js';
import type { Usage } from './types.js';

// 每局花费：适配器把每次调用的用量报上来，按 models.json 里的价格折成人民币、美元；
// 花到预算八成进入“省”档（配角只在有事时才想、核心人物发呆间隔加倍），花完进入“停”档（真模型全停，改用内置行为）。

export type BudgetLevel = 'ok' | 'saving' | 'over';

export interface Price {
  in: number;
  cached?: number;
  out: number;
}

/**
 * models.json 里没标价的模型（比如角色自己指定的 openai / anthropic / gemini）按这个价算：
 * 取常见国外中档模型的上沿（约 3 美元进 / 15 美元出，每百万 token，×7.2 折人民币），宁可高估，预算保护先触发
 */
export const DEFAULT_PRICE: Price = { in: 21.6, cached: 2.16, out: 108 };

export interface CostState {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cny: number;
  /** 按 provider 分 */
  byProvider: Record<string, { calls: number; cny: number }>;
}

export class CostMeter {
  calls = 0;
  promptTokens = 0;
  cachedTokens = 0;
  completionTokens = 0;
  cny = 0;
  byProvider: Record<string, { calls: number; cny: number }> = {};

  constructor(
    readonly catalog: ModelCatalog,
    readonly budgetUsd = catalog.budget.usdPerMatch,
    readonly cnyPerUsd = catalog.budget.cnyPerUsd,
  ) {}

  priceFor(provider: string, model?: string): Price {
    if (provider === 'mock' || provider === 'ollama') return { in: 0, cached: 0, out: 0 };
    const entries = Object.values(this.catalog.models).filter((m) => m.provider === provider);
    const exact = model ? entries.find((m) => m.model === model) : undefined;
    return exact?.price ?? entries.find((m) => m.price)?.price ?? DEFAULT_PRICE;
  }

  /** 一次调用多少人民币（不记账） */
  cnyOf(u: Usage): number {
    const p = this.priceFor(u.provider, u.model);
    const cached = Math.min(u.cachedTokens, u.promptTokens);
    const uncached = Math.max(0, u.promptTokens - cached);
    return (uncached * p.in + cached * (p.cached ?? p.in) + u.completionTokens * p.out) / 1e6;
  }

  usdOf(u: Usage): number {
    return this.cnyOf(u) / this.cnyPerUsd;
  }

  add(u: Usage) {
    const cached = Math.min(u.cachedTokens, u.promptTokens);
    const cny = this.cnyOf(u);
    this.calls++;
    this.promptTokens += u.promptTokens;
    this.cachedTokens += cached;
    this.completionTokens += u.completionTokens;
    this.cny += cny;
    const bp = (this.byProvider[u.provider] ??= { calls: 0, cny: 0 });
    bp.calls++;
    bp.cny += cny;
  }

  get usd() {
    return this.cny / this.cnyPerUsd;
  }

  get level(): BudgetLevel {
    const r = this.budgetUsd > 0 ? this.usd / this.budgetUsd : 0;
    return r >= 1 ? 'over' : r >= 0.8 ? 'saving' : 'ok';
  }

  summary() {
    return {
      usd: Math.round(this.usd * 10000) / 10000,
      cny: Math.round(this.cny * 1000) / 1000,
      budgetUsd: this.budgetUsd,
      level: this.level,
      calls: this.calls,
      promptTokens: this.promptTokens,
      cachedTokens: this.cachedTokens,
      completionTokens: this.completionTokens,
      byProvider: Object.fromEntries(Object.entries(this.byProvider).map(([k, v]) => [k, { calls: v.calls, cny: Math.round(v.cny * 1000) / 1000 }])),
    };
  }

  toState(): CostState {
    return { calls: this.calls, promptTokens: this.promptTokens, cachedTokens: this.cachedTokens, completionTokens: this.completionTokens, cny: this.cny, byProvider: this.byProvider };
  }

  restore(s: Partial<CostState> | undefined | null) {
    if (!s) return;
    this.calls = s.calls ?? 0;
    this.promptTokens = s.promptTokens ?? 0;
    this.cachedTokens = s.cachedTokens ?? 0;
    this.completionTokens = s.completionTokens ?? 0;
    this.cny = s.cny ?? 0;
    this.byProvider = s.byProvider ?? {};
  }
}

export const LEVEL_TEXT: Record<BudgetLevel, string> = {
  ok: '',
  saving: '这局的模型预算用了八成：路人没事不再开口，核心人物发呆的时间长了些。',
  over: '这局的模型预算用完了：居民们改用内置的简单行为，说书人改用内置事件。',
};
