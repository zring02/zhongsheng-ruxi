import { sanitizeText } from './persona.js';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';
import type { BlockTheme, GameOptions, RoleDef, Scenario, StorytellerConfig } from './types.js';
import { BLOCK_TYPES, MAX_WORLD_XZ, MIN_WORLD_XZ } from './voxel.js';

// 剧本：从 scenarios/*.json 读入、校验；开局时按玩家选项（剧情/沙盒、扮演谁、自定义设定）合成一局的名单

/** 地形生成固定产生这五个区域，剧本只是给它们改名字和描述 */
export const LANDMARK_IDS = ['spawn', 'forest', 'quarry', 'sandpit', 'hill'] as const;
const GENRES = ['modern', 'ancient', 'fantasy', 'scifi', 'book', 'custom'] as const;
const ACTIVITIES = ['quiet', 'normal', 'dramatic'] as const;
export const DEFAULT_PENALTIES = { steal: '当众揭穿，东西没收，关起来一阵', eavesdrop: '被当众斥责，名声受损' };
export const DEFAULT_CURRENCY = { name: '钱', start: 30, askCost: 5 };

const text = (v: unknown, what: string, max = 4000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} 必须是非空字符串`);
  return v.trim().slice(0, max);
};
const optText = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const idText = (v: unknown, what: string) => {
  const s = text(v, what, 40);
  if (!/^[\w-]+$/.test(s)) throw new Error(`${what}“${s}”只能用字母、数字、下划线、连字符`);
  return s;
};

export function validateRole(raw: any, where: string, defaultTier: 'core' | 'extra' = 'extra'): RoleDef {
  if (!raw || typeof raw !== 'object') throw new Error(`${where} 不是对象`);
  const id = idText(raw.id, `${where}.id`);
  const tier = raw.tier === 'core' || raw.tier === 'extra' ? raw.tier : defaultTier;
  const relations: Record<string, string> = {};
  if (raw.relations && typeof raw.relations === 'object') {
    for (const [k, v] of Object.entries(raw.relations)) if (typeof v === 'string' && v.trim()) relations[k] = v.trim().slice(0, 200);
  }
  const inventory: Record<string, number> = {};
  if (raw.inventory && typeof raw.inventory === 'object') {
    for (const [k, v] of Object.entries(raw.inventory)) {
      const n = Number(v);
      if (k.trim() && Number.isFinite(n) && n > 0) inventory[k.trim().slice(0, 30)] = Math.round(n);
    }
  }
  let model: RoleDef['model'];
  if (raw.model && typeof raw.model === 'object' && typeof raw.model.provider === 'string') {
    model = { provider: raw.model.provider, model: optText(raw.model.model, 100), baseUrlEnv: optText(raw.model.baseUrlEnv, 60), apiKeyEnv: optText(raw.model.apiKeyEnv, 60) };
  }
  const home = optText(raw.home, 20);
  if (home && !(LANDMARK_IDS as readonly string[]).includes(home)) throw new Error(`${where}.home“${home}”不是地标 id，可选: ${LANDMARK_IDS.join('/')}`);
  return {
    id,
    name: text(raw.name, `${where}.name`, 40),
    tier,
    public: text(raw.public, `${where}.public`, 300),
    personality: text(raw.personality, `${where}.personality`, 400),
    speech: optText(raw.speech, 300),
    wish: optText(raw.wish, 300) ?? '过好自己的日子',
    knot: optText(raw.knot, 300) ?? '没有什么放不下的',
    relations: Object.keys(relations).length ? relations : undefined,
    fate: optText(raw.fate, 400),
    home,
    color: optText(raw.color, 20),
    inventory: Object.keys(inventory).length ? inventory : undefined,
    model,
    playable: raw.playable === true,
    alert: raw.alert === true,
  };
}

function validateStoryteller(raw: any, where: string): StorytellerConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const activity = (ACTIVITIES as readonly string[]).includes(r.activity) ? r.activity : 'normal';
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string' && (s as string).trim()).map((s: string) => s.trim().slice(0, 300)) : []);
  const seeds = strList(r.seeds);
  const pool = strList(r.pool);
  const secrets = Array.isArray(r.secrets)
    ? r.secrets
        .filter((x: any) => x && typeof x.text === 'string' && x.text.trim())
        .map((x: any) => ({ text: x.text.trim().slice(0, 400), involves: strList(x.involves).map((i) => i.slice(0, 40)), when: optText(x.when, 200) }))
    : undefined;
  let bigEvent: StorytellerConfig['bigEvent'];
  if (r.bigEvent && typeof r.bigEvent === 'object') {
    bigEvent = { hint: text(r.bigEvent.hint, `${where}.bigEvent.hint`, 400) };
    if (Number.isFinite(Number(r.bigEvent.afterMinutes))) bigEvent.afterMinutes = Number(r.bigEvent.afterMinutes);
    if (Number.isFinite(Number(r.bigEvent.afterDay))) bigEvent.afterDay = Number(r.bigEvent.afterDay);
  }
  const track = Array.isArray(r.track)
    ? r.track
        .filter((t: any) => t && Number.isFinite(Number(t.day)) && typeof t.hint === 'string')
        .map((t: any) => ({ day: Math.max(1, Math.round(Number(t.day))), name: optText(t.name, 60) ?? '', hint: t.hint.trim().slice(0, 400) }))
    : undefined;
  return { activity, seeds, pool, bigEvent, track: track?.length ? track : undefined, secrets: secrets?.length ? secrets : undefined };
}

export function validateScenario(raw: any, where = '剧本'): Scenario {
  if (!raw || typeof raw !== 'object') throw new Error(`${where} 不是对象`);
  const id = idText(raw.id, `${where}.id`);
  const w = where + `(${id})`;
  const genre = (GENRES as readonly string[]).includes(raw.genre) ? raw.genre : 'custom';
  const minutes = Number(raw.duration?.minutes);
  const days = Number(raw.duration?.days);
  const duration = { minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 60, days: Number.isFinite(days) && days > 0 ? Math.round(days) : 3 };

  const world = raw.world && typeof raw.world === 'object' ? raw.world : {};
  const landmarks = LANDMARK_IDS.map((lid) => {
    const l = Array.isArray(world.landmarks) ? world.landmarks.find((x: any) => x?.id === lid) : null;
    return { id: lid, name: optText(l?.name, 30) ?? lid, description: optText(l?.description, 200) ?? '' };
  });
  let theme: BlockTheme | undefined;
  if (world.theme && typeof world.theme === 'object') {
    theme = {};
    for (const [k, v] of Object.entries<any>(world.theme)) {
      if (!BLOCK_TYPES.some((b) => b.name === k)) throw new Error(`${w}.world.theme 里的“${k}”不是方块名`);
      theme[k] = { cn: optText(v?.cn, 20), color: optText(v?.color, 20) };
    }
  }
  const jail = optText(world.jail, 20);
  let size: { x: number; z: number } | undefined;
  if (world.size && typeof world.size === 'object') {
    const sx = Number(world.size.x);
    const sz = Number(world.size.z);
    if (!Number.isFinite(sx) || !Number.isFinite(sz)) throw new Error(`${w}.world.size 要有数字 x、z`);
    if (sx < MIN_WORLD_XZ || sz < MIN_WORLD_XZ || sx > MAX_WORLD_XZ || sz > MAX_WORLD_XZ) throw new Error(`${w}.world.size 的 x、z 要在 ${MIN_WORLD_XZ}–${MAX_WORLD_XZ} 之间`);
    size = { x: Math.round(sx), z: Math.round(sz) };
  }
  if (jail && !(LANDMARK_IDS as readonly string[]).includes(jail)) throw new Error(`${w}.world.jail“${jail}”不是地标 id`);

  if (!Array.isArray(raw.roles) || !raw.roles.length) throw new Error(`${w}.roles 至少要有一个角色`);
  const roles: RoleDef[] = raw.roles.map((r: any, i: number) => validateRole(r, `${w}.roles[${i}]`));
  const ids = new Set<string>();
  for (const r of roles) {
    if (ids.has(r.id)) throw new Error(`${w} 角色 id 重复: ${r.id}`);
    ids.add(r.id);
  }
  if (!raw.player) throw new Error(`${w}.player（玩家角色模板）不能缺`);
  const player = validateRole({ tier: 'core', ...raw.player }, `${w}.player`, 'core');
  if (ids.has(player.id)) throw new Error(`${w}.player.id 和某个角色重复: ${player.id}`);
  for (const r of [...roles, player]) {
    for (const k of Object.keys(r.relations ?? {})) if (!ids.has(k) && k !== player.id) throw new Error(`${w} 角色 ${r.id} 的 relations 引用了不存在的角色“${k}”`);
  }
  const storyteller = validateStoryteller(raw.storyteller, w);
  for (const sec of storyteller.secrets ?? []) {
    for (const k of sec.involves) if (!ids.has(k) && k !== player.id) throw new Error(`${w} 伏笔“${sec.text.slice(0, 20)}…”涉及的角色“${k}”不存在`);
  }
  const penalties = raw.penalties && typeof raw.penalties === 'object' ? { steal: optText(raw.penalties.steal, 200) ?? DEFAULT_PENALTIES.steal, eavesdrop: optText(raw.penalties.eavesdrop, 200) ?? DEFAULT_PENALTIES.eavesdrop } : undefined;
  let currency: Scenario['currency'];
  if (raw.currency && typeof raw.currency === 'object') {
    const num = (v: unknown, what: string, fallback: number) => {
      if (v === undefined || v === null) return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`${w}.currency.${what} 要是 0 到 100000 的数`);
      return Math.round(n);
    };
    currency = { name: text(raw.currency.name, `${w}.currency.name`, 10), start: num(raw.currency.start, 'start', DEFAULT_CURRENCY.start), askCost: num(raw.currency.askCost, 'askCost', DEFAULT_CURRENCY.askCost) };
  }
  const features = raw.features && typeof raw.features === 'object' ? { wechat: !!raw.features.wechat } : undefined;
  let coreSets: Record<string, string[]> | undefined;
  if (raw.coreSets && typeof raw.coreSets === 'object') {
    coreSets = {};
    for (const [k, v] of Object.entries(raw.coreSets)) {
      if (k !== 'player' && k !== player.id && !ids.has(k)) throw new Error(`${w}.coreSets 的 key“${k}”不是角色 id`);
      if (!Array.isArray(v)) throw new Error(`${w}.coreSets.${k} 应该是角色 id 数组`);
      for (const id of v) if (!ids.has(id)) throw new Error(`${w}.coreSets.${k} 引用了不存在的角色“${id}”`);
      coreSets[k === player.id ? 'player' : k] = v.filter((x: unknown) => typeof x === 'string');
    }
  }

  return {
    id,
    name: text(raw.name, `${w}.name`, 60),
    genre,
    tagline: optText(raw.tagline, 200) ?? '',
    background: text(raw.background, `${w}.background`, 3000),
    playerIntro: optText(raw.playerIntro, 1000),
    duration,
    world: { seed: Number.isFinite(Number(world.seed)) ? Number(world.seed) : undefined, size, theme, landmarks, jail },
    roles,
    player,
    storyteller,
    penalties,
    currency,
    features,
    coreSets,
  };
}

export function loadScenarios(dir = process.env.SCENARIOS_DIR ?? resolve(ROOT, 'scenarios')): Scenario[] {
  const out: Scenario[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    const s = validateScenario(raw, `剧本文件 ${f}`);
    if (out.some((o) => o.id === s.id)) throw new Error(`剧本 id 重复: ${s.id}（${f}）`);
    out.push(s);
  }
  return out;
}

/** 给前端的剧本摘要：不带 AI 角色的心愿/心结/命运 */
export function summarizeScenario(s: Scenario) {
  return {
    id: s.id,
    name: s.name,
    genre: s.genre,
    tagline: s.tagline,
    background: s.background,
    playerIntro: s.playerIntro ?? '',
    duration: s.duration,
    landmarks: s.world.landmarks,
    roles: s.roles.map((r) => ({ id: r.id, name: r.name, tier: r.tier, public: r.public, playable: !!r.playable, color: r.color })),
    player: { id: s.player.id, name: s.player.name, public: s.player.public, personality: s.player.personality, wish: s.player.wish, knot: s.player.knot },
    currency: s.currency ?? DEFAULT_CURRENCY,
    features: { wechat: !!s.features?.wechat },
    storytellerActivity: s.storyteller.activity,
    coreSets: s.coreSets ?? null,
  };
}

export interface Roster {
  /** 本局实际生效的剧本（沙盒自定义已合并进去） */
  scenario: Scenario;
  /** 由 AI 扮演的角色 */
  ais: RoleDef[];
  /** 玩家扮演的角色；观察模式为 null */
  player: RoleDef | null;
}

/**
 * 按开局选项合成本局名单：
 * - 沙盒：叠加自定义设定、删角色、加角色、说书人活跃度；
 * - 玩家：'player' = 剧本给的主角模板，或某个 playable 角色（那个角色就不再由 AI 演）；不填 = 观察模式。
 */
export function buildRoster(base: Scenario, options: GameOptions): Roster {
  let scenario: Scenario = structuredClone(base);
  let ais = scenario.roles;
  if (options.mode === 'sandbox' && options.sandbox) {
    const sb = options.sandbox;
    if (sb.customText?.trim()) scenario.background += `\n\n【玩家补充的设定】${sb.customText.trim().slice(0, 2000)}`;
    if (sb.removeRoles?.length) ais = ais.filter((r) => !sb.removeRoles!.includes(r.id));
    if (sb.extraRoles?.length) {
      for (const [i, raw] of sb.extraRoles.entries()) {
        const r = validateRole(raw, `自定义角色[${i}]`, 'extra');
        if (ais.some((o) => o.id === r.id) || r.id === scenario.player.id) throw new Error(`自定义角色 id“${r.id}”和已有角色重复`);
        ais.push(r);
      }
    }
    if (sb.storytellerActivity) scenario.storyteller.activity = sb.storytellerActivity;
    scenario.roles = ais;
  }

  let player: RoleDef | null = null;
  if (options.playerRole) {
    if (options.playerRole === 'player' || options.playerRole === scenario.player.id) {
      player = { ...scenario.player };
    } else {
      const r = ais.find((x) => x.id === options.playerRole);
      if (!r) throw new Error(`没有叫“${options.playerRole}”的角色`);
      if (!r.playable) throw new Error(`角色“${r.name}”不能由玩家扮演`);
      player = { ...r };
      ais = ais.filter((x) => x !== r);
    }
    if (options.playerName?.trim()) player.name = sanitizeText(options.playerName, 20) || player.name;
    if (options.playerWish?.trim()) player.wish = sanitizeText(options.playerWish, 200) || player.wish;
    player.tier = 'core';
  }
  if (!ais.length) throw new Error('这局一个 AI 角色都没有');
  // 穿书模式：核心六人跟着玩家穿成谁来定，命中名单的用好模型，其余降为路人
  const key = !options.playerRole ? 'player' : options.playerRole === scenario.player.id ? 'player' : options.playerRole;
  const coreSet = scenario.coreSets?.[key] ?? scenario.coreSets?.player;
  if (coreSet) {
    const tier = (r: RoleDef): RoleDef => ({ ...r, tier: coreSet.includes(r.id) ? 'core' : 'extra' });
    ais = ais.map(tier);
    // 剧本里的角色表保留被玩家扮演的那个角色（存档读回时还要按同一个 playerRole 再分一次）
    scenario.roles = scenario.roles.map(tier);
  }
  return { scenario, ais, player };
}

// —— 方块主题：按剧本改方块的中文名和颜色（全局只有一局，直接改方块表，开新局时先还原）——
const DEFAULT_LOOK = BLOCK_TYPES.map((b) => ({ cn: b.cn, color: b.color }));

export function applyTheme(theme?: BlockTheme) {
  BLOCK_TYPES.forEach((b, i) => Object.assign(b, DEFAULT_LOOK[i]));
  if (!theme) return;
  for (const [name, look] of Object.entries(theme)) {
    const b = BLOCK_TYPES.find((x) => x.name === name);
    if (!b) continue;
    if (look.cn) b.cn = look.cn;
    if (look.color) b.color = look.color;
  }
}
