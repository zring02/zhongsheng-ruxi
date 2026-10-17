import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isKnownProvider, PROVIDERS, resolveAdapter } from './adapters/index.js';
import { ROOT } from './config.js';
import type { AgentConfig, ModelSpec, RoleDef } from './types.js';

// 模型名单与分档：核心人物用好一点的模型，路人用便宜的，说书人单独一个

export interface ModelEntry extends ModelSpec {
  label?: string;
}

export interface ModelCatalog {
  models: Record<string, ModelEntry>;
  tiers: { core: string[]; extra: string[]; storyteller: string };
  /** 每档的输出上限（token）：每次只许回几句话 */
  maxTokens: { core: number; extra: number; storyteller: number };
  /** 每局预算（美元）和汇率：超过八成开始省，超过就停用真模型 */
  budget: { usdPerMatch: number; cnyPerUsd: number };
}

const DEFAULT_MAX_TOKENS = { core: 220, extra: 160, storyteller: 900 };
const DEFAULT_BUDGET = { usdPerMatch: 1, cnyPerUsd: 7.2 };

export function loadModels(file = process.env.MODELS_CONFIG ?? resolve(ROOT, 'models.json')): ModelCatalog {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const models: Record<string, ModelEntry> = {};
  for (const [key, v] of Object.entries<any>(raw.models ?? {})) {
    if (!v || typeof v.provider !== 'string') throw new Error(`models.json 里的 ${key} 缺少 provider`);
    if (!isKnownProvider(v.provider)) throw new Error(`models.json 里 ${key} 的 provider“${v.provider}”不认识，可选: ${PROVIDERS.join('/')}`);
    const price = v.price && typeof v.price === 'object' && Number.isFinite(Number(v.price.in)) && Number.isFinite(Number(v.price.out)) ? { in: Number(v.price.in), cached: Number.isFinite(Number(v.price.cached)) ? Number(v.price.cached) : undefined, out: Number(v.price.out) } : undefined;
    const extraBody = v.extraBody && typeof v.extraBody === 'object' && !Array.isArray(v.extraBody) ? (v.extraBody as Record<string, unknown>) : undefined;
    models[key] = { provider: v.provider, model: v.model, baseUrlEnv: v.baseUrlEnv, apiKeyEnv: v.apiKeyEnv, label: v.label, price, extraBody };
  }
  if (!models.mock) models.mock = { provider: 'mock', label: '假模型' };
  const tier = (name: string, fallback: string[]) => {
    const list: string[] = Array.isArray(raw.tiers?.[name]) ? raw.tiers[name] : fallback;
    for (const k of list) if (!models[k]) throw new Error(`models.json 的 tiers.${name} 引用了不存在的模型“${k}”`);
    return list.length ? list : ['mock'];
  };
  const storyteller = typeof raw.tiers?.storyteller === 'string' ? raw.tiers.storyteller : 'mock';
  if (!models[storyteller]) throw new Error(`models.json 的 tiers.storyteller 引用了不存在的模型“${storyteller}”`);
  const mt = { ...DEFAULT_MAX_TOKENS };
  for (const k of ['core', 'extra', 'storyteller'] as const) {
    const n = Number(raw.maxTokens?.[k]);
    if (Number.isFinite(n) && n > 0) mt[k] = Math.round(n);
  }
  const budget = { ...DEFAULT_BUDGET };
  const envBudget = Number(process.env.BUDGET_USD);
  if (Number.isFinite(Number(raw.budget?.usdPerMatch)) && Number(raw.budget.usdPerMatch) > 0) budget.usdPerMatch = Number(raw.budget.usdPerMatch);
  if (Number.isFinite(envBudget) && envBudget > 0) budget.usdPerMatch = envBudget;
  if (Number.isFinite(Number(raw.budget?.cnyPerUsd)) && Number(raw.budget.cnyPerUsd) > 0) budget.cnyPerUsd = Number(raw.budget.cnyPerUsd);
  return { models, tiers: { core: tier('core', ['mock']), extra: tier('extra', ['mock']), storyteller }, maxTokens: mt, budget };
}

/** 这个模型现在能不能真的调用（有没有 key）。用一个临时的角色配置去问适配器 */
export function modelAvailable(entry: ModelSpec): boolean {
  const probe: AgentConfig = { id: '_probe', name: '_probe', color: '#000', personality: '', ...entry };
  return !resolveAdapter(probe).fallback;
}

const PALETTE = ['#d97757', '#10a37f', '#4285f4', '#f4b400', '#9b59b6', '#e67e22', '#1abc9c', '#e84393', '#2d98da', '#8e6e53', '#6c5ce7', '#fd79a8'];

/**
 * 给一组角色分配模型并生成运行时配置。
 * - 角色自己指定了 model 就用它；
 * - 否则按 tier 从名单里轮流取：先用有 key 的，尽量让核心人物各用不同牌子的模型（性格更不一样，也保住“多模型同台”的卖点）；
 * - 名单里一个都没配 key 时全部落到 mock，开发时零成本能跑。
 */
export function assignModels(roles: RoleDef[], catalog: ModelCatalog): AgentConfig[] {
  const usable = (keys: string[]) => keys.filter((k) => modelAvailable(catalog.models[k]));
  const coreOk = usable(catalog.tiers.core);
  const extraOk = usable(catalog.tiers.extra);
  // 路人档一个 key 都没配时，先用核心档里能用的模型（比如只有 DeepSeek 一家 key 时大家都走 DeepSeek），再没有才 mock
  const pools = { core: coreOk.length ? coreOk : ['mock'], extra: extraOk.length ? extraOk : coreOk.length ? coreOk : ['mock'] };
  const used = new Map<string, number>();
  const pick = (tier: 'core' | 'extra'): ModelEntry => {
    const pool = pools[tier];
    // 用得最少的优先；同样少的话优先还没出现过的 provider
    let best = pool[0];
    let bestScore = Infinity;
    for (const k of pool) {
      const provider = catalog.models[k].provider;
      const providerUses = [...used.entries()].filter(([u]) => catalog.models[u].provider === provider).reduce((s, [, n]) => s + n, 0);
      const score = (used.get(k) ?? 0) * 10 + providerUses;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    used.set(best, (used.get(best) ?? 0) + 1);
    return catalog.models[best];
  };
  return roles.map((role, i) => {
    const spec: ModelSpec = role.model ?? pick(role.tier);
    return {
      id: role.id,
      name: role.name,
      color: role.color ?? PALETTE[i % PALETTE.length],
      personality: role.personality,
      home: role.home,
      tier: role.tier,
      role,
      provider: spec.provider,
      model: spec.model,
      baseUrlEnv: spec.baseUrlEnv,
      apiKeyEnv: spec.apiKeyEnv,
      extraBody: spec.extraBody,
    };
  });
}

/** 说书人用的模型配置（没 key 时由调用方降级为内置的随机事件） */
export function storytellerConfig(catalog: ModelCatalog): AgentConfig {
  const spec = catalog.models[catalog.tiers.storyteller];
  return { id: '_storyteller', name: '说书人', color: '#ffffff', personality: '', ...spec };
}
