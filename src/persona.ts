import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.js';
import type { Difficulty, PersonaCard, PromptWorldFile, RoleDef, Scenario } from './types.js';

/**
 * 提示词包：模板、人设卡、难度档位和渲染器，全部来自“AI角色提示词”线程维护的 prompts/ 目录
 * （共享目录里是 /mnt/project-files/prompts，和 ai-town/ 并列）。这里只读，不改那边的文件。
 *
 * 找目录的顺序：环境变量 PROMPTS_DIR → ai-town/prompts → ai-town/../prompts。
 * 找不到或者加载失败时返回 null，框架退回内置的占位提示词（prompt.ts 的 buildSystemPrompt / buildUserPrompt），
 * 游戏照样能跑，只是角色没那么入戏。
 */

export interface DifficultyServer {
  /** 被发现概率加减（-0.1 / 0 / +0.1） */
  detect_delta: number;
  /** 谎话能被哪些途径拆穿 */
  lie_exposure: string[];
  /** 小秘密松口的信任门槛 */
  minor_secret_trust: number;
  /** 要紧秘密松口的信任门槛 */
  major_secret_trust: number;
  /** 要紧秘密要不要独处才说 */
  major_needs_private: boolean;
  /** 要紧秘密要不要在要紧关头（气头上、病着、被关）才说 */
  major_needs_crisis?: boolean;
  trust_recovery: 'fast' | 'normal' | 'slow';
}

export interface DifficultyDef {
  level: Difficulty;
  name: string;
  /** 进系统提示词的那段话 */
  text: string;
  server: DifficultyServer;
}

/** 渲染器（prompts/tools/render.mjs 导出的函数） */
export interface PromptRenderer {
  renderSystem(card: PersonaCard, world: PromptWorldFile, opts: { actions: string[]; roster?: string[]; player?: { id: string; name: string }; names?: Record<string, string>; difficulty?: Difficulty }): string;
  renderTurn(card: PersonaCard, d: TurnData): string;
  renderMemorySummary(card: PersonaCard, oldSummary: string, recentEvents: string[], maxChars?: number): string;
  describeFeeling(name: string, affection: number, trust: number, distrust?: boolean): string;
  sanitizePlayerText(s: string, max?: number): string;
  loadWorld(scenario: string): PromptWorldFile;
  loadCard(scenario: string, id: string): PersonaCard;
  listCards(scenario: string): string[];
}

/** 回合提示词的各栏（见 prompts/README.md“回合里各栏放什么”） */
export interface TurnData {
  time: string;
  place: string;
  scene: string;
  feelings?: string;
  memory?: string;
  heard?: string[];
  events?: string[];
  claims?: string[];
  state?: string;
  confide?: string[];
  private?: string[];
  trigger?: string;
}

export interface PromptPack {
  dir: string;
  renderer: PromptRenderer;
  difficulty: Record<Difficulty, DifficultyDef>;
  /** 这个剧本有没有写好的世界描述和人设卡 */
  hasScenario(scenarioId: string): boolean;
  /** 剧本的世界描述：有 world.json 用它，没有就从剧本背景生成 */
  world(scenario: Scenario): PromptWorldFile;
  /** 角色的人设卡：有卡用卡，没卡就从剧本角色生成一张简卡 */
  card(scenarioId: string, role: RoleDef, world: PromptWorldFile): PersonaCard;
}

/** 没有 prompts/ 目录时也要有的难度数值（和 templates/difficulty.json 保持一致） */
export const DEFAULT_DIFFICULTY: Record<Difficulty, DifficultyDef> = {
  easy: {
    level: 'easy',
    name: '宽厚',
    text: '你待人宽厚，不大往坏处想。别人说的话，只要听着有几分道理你就信了；被人哄几句就软了；东西少了、话被人听去了，你也不大留心。只有被骗得很明显时你才会生气，气也消得快。',
    server: { detect_delta: -0.1, lie_exposure: ['witnessed'], minor_secret_trust: 20, major_secret_trust: 50, major_needs_private: false, trust_recovery: 'fast' },
  },
  normal: {
    level: 'normal',
    name: '寻常',
    text: '你和寻常人一样：熟人说的话你多半信，生人说的话你要掂量掂量；前后对不上的话你会追问；东西少了你会想想是谁拿的。被人骗过一回，你会记着。',
    server: { detect_delta: 0, lie_exposure: ['witnessed', 'cross_check', 'evidence', 'storyteller'], minor_secret_trust: 40, major_secret_trust: 70, major_needs_private: true, trust_recovery: 'normal' },
  },
  hard: {
    level: 'hard',
    name: '精明',
    text: '你很精明，不轻易信人。别人说的话你都要掂量他图什么；前后有一点对不上，你就记下来，找机会当面戳穿或者告诉别人；谁平白对你好，你先疑他有所求；东西少了一点、身边有人鬼鬼祟祟，你马上就能觉出来。别人跟你说的事，你会找第三个人旁敲侧击核实一下。',
    server: { detect_delta: 0.1, lie_exposure: ['witnessed', 'cross_check', 'evidence', 'storyteller', 'active_verify'], minor_secret_trust: 60, major_secret_trust: 85, major_needs_private: true, major_needs_crisis: true, trust_recovery: 'slow' },
  },
};

export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

export function isDifficulty(x: unknown): x is Difficulty {
  return typeof x === 'string' && (DIFFICULTIES as string[]).includes(x);
}

let pack: PromptPack | null = null;
let loaded = false;

/** 当前加载的提示词包（server 启动时 loadPromptPack() 过才有） */
export function promptPack(): PromptPack | null {
  return pack;
}

/** 难度定义：优先用提示词包里的 difficulty.json */
export function difficultyDef(level: Difficulty = 'normal'): DifficultyDef {
  return pack?.difficulty[level] ?? DEFAULT_DIFFICULTY[level];
}

export function resolvePromptsDir(): string | null {
  const candidates = [process.env.PROMPTS_DIR, resolve(ROOT, 'prompts'), resolve(ROOT, '..', 'prompts')].filter((x): x is string => !!x && x.trim() !== '');
  for (const dir of candidates) if (existsSync(resolve(dir, 'tools', 'render.mjs')) && existsSync(resolve(dir, 'templates', 'system.core.md'))) return resolve(dir);
  return null;
}

/**
 * 加载提示词包（异步：渲染器是 ESM 文件，要 import()）。只在进程启动时调一次。
 * 返回 null 表示没找到或加载失败，并且 promptPack() 之后也返回 null。
 */
export async function loadPromptPack(dir = resolvePromptsDir()): Promise<PromptPack | null> {
  loaded = true;
  if (!dir) {
    pack = null;
    return null;
  }
  try {
    const mod = (await import(pathToFileURL(resolve(dir, 'tools', 'render.mjs')).href)) as Partial<PromptRenderer>;
    for (const fn of ['renderSystem', 'renderTurn', 'renderMemorySummary', 'describeFeeling', 'sanitizePlayerText', 'loadWorld', 'loadCard', 'listCards'] as const) {
      if (typeof mod[fn] !== 'function') throw new Error(`render.mjs 没有导出 ${fn}`);
    }
    const renderer = mod as PromptRenderer;
    const difficulty = readDifficulty(dir);
    const hasScenario = (id: string) => existsSync(resolve(dir, 'scenarios', id, 'world.json'));
    pack = {
      dir,
      renderer,
      difficulty,
      hasScenario,
      world(scenario) {
        if (hasScenario(scenario.id)) {
          try {
            return renderer.loadWorld(scenario.id);
          } catch (e) {
            console.warn(`[提示词] ${scenario.id}/world.json 读不了：${(e as Error).message}，改用剧本背景`);
          }
        }
        return worldFromScenario(scenario);
      },
      card(scenarioId, role, world) {
        if (existsSync(resolve(dir, 'scenarios', scenarioId, 'cards', `${role.id}.json`))) {
          try {
            const c = renderer.loadCard(scenarioId, role.id);
            // 卡上的 tier 以本局分配为准（穿书模式核心六人按玩家穿成谁变）
            return { ...c, tier: role.tier };
          } catch (e) {
            console.warn(`[提示词] ${scenarioId}/cards/${role.id}.json 读不了：${(e as Error).message}，改用剧本角色生成简卡`);
          }
        }
        return cardFromRole(role, world);
      },
    };
    return pack;
  } catch (e) {
    console.warn(`[提示词] 加载 ${dir} 失败：${(e as Error).message}，改用内置占位提示词`);
    pack = null;
    return null;
  }
}

function readDifficulty(dir: string): Record<Difficulty, DifficultyDef> {
  const out = { ...DEFAULT_DIFFICULTY };
  try {
    const raw = JSON.parse(readFileSync(resolve(dir, 'templates', 'difficulty.json'), 'utf8'));
    for (const level of DIFFICULTIES) {
      const d = raw[level];
      if (!d || typeof d.text !== 'string') continue;
      const s = d.server ?? {};
      out[level] = {
        level,
        name: typeof d.name === 'string' ? d.name : DEFAULT_DIFFICULTY[level].name,
        text: d.text,
        server: {
          detect_delta: Number.isFinite(Number(s.detect_delta)) ? Number(s.detect_delta) : DEFAULT_DIFFICULTY[level].server.detect_delta,
          lie_exposure: Array.isArray(s.lie_exposure) ? s.lie_exposure.filter((x: unknown) => typeof x === 'string') : DEFAULT_DIFFICULTY[level].server.lie_exposure,
          minor_secret_trust: Number.isFinite(Number(s.minor_secret_trust)) ? Number(s.minor_secret_trust) : DEFAULT_DIFFICULTY[level].server.minor_secret_trust,
          major_secret_trust: Number.isFinite(Number(s.major_secret_trust)) ? Number(s.major_secret_trust) : DEFAULT_DIFFICULTY[level].server.major_secret_trust,
          major_needs_private: typeof s.major_needs_private === 'boolean' ? s.major_needs_private : DEFAULT_DIFFICULTY[level].server.major_needs_private,
          major_needs_crisis: typeof s.major_needs_crisis === 'boolean' ? s.major_needs_crisis : DEFAULT_DIFFICULTY[level].server.major_needs_crisis,
          trust_recovery: ['fast', 'normal', 'slow'].includes(s.trust_recovery) ? s.trust_recovery : DEFAULT_DIFFICULTY[level].server.trust_recovery,
        },
      };
    }
  } catch (e) {
    console.warn(`[提示词] templates/difficulty.json 读不了：${(e as Error).message}，用内置数值`);
  }
  return out;
}

/** 剧本没有 world.json 时，从剧本背景和地标拼一份世界描述 */
export function worldFromScenario(scenario: Scenario): PromptWorldFile {
  const places = scenario.world.landmarks.map((l) => `${l.name}（${l.description}）`).join('、');
  return {
    scenario: scenario.id,
    world: `${scenario.background}\n这里的地方：${places}。\n你熟悉身边每个人平日的性子。谁要是忽然不像他自己了，说话做事变了样，你会察觉。${scenario.genre === 'book' ? '\n你不知道自己活在一本书里，也不知道任何没发生的事。' : ''}`,
    world_brief: `${scenario.tagline || scenario.background.slice(0, 80)} 这里的地方：${scenario.world.landmarks.map((l) => l.name).join('、')}。`,
    taboo_words: ['AI', '人工智能', '模型', '系统', '提示词', '设定', '剧情', '角色扮演', '玩家', '游戏'],
    ooc_default: '当是对方在说胡话或者打趣你，照自己的性子回一句',
    steal_penalty: scenario.penalties?.steal,
  };
}

/** 没有人设卡的角色：从剧本的角色定义生成一张简卡，走同一套模板（措辞由提示词线程之后补） */
export function cardFromRole(role: RoleDef, world: PromptWorldFile): PersonaCard {
  const speech = role.speech ?? '';
  // 角色定义里的说话风格常带一句“例如：‘……’”样板，抠出来当 sample_lines
  const quoted = [...speech.matchAll(/[“"「]([^”"」]{2,40})[”"」]/g)].map((m) => m[1]).slice(0, 3);
  return {
    id: role.id,
    name: role.name,
    tier: role.tier,
    generated: true,
    identity: role.public,
    personality: role.personality,
    wish: role.wish,
    knot: role.knot,
    boundaries: '做不出和自己身份、性子完全相反的事',
    speech: { style: speech || '像这个身份的普通人那样说话', sample_lines: quoted.length ? quoted : [`${role.name}平时就是这么说话的。`] },
    deception: '对自己不利、或者能护着你在意的人的事，你会撒谎、瞒着、说一半留一半。',
    conflict: '被人轻慢、冤枉、抢你的东西、戳你的心结，你会顶回去，话赶话就吵起来。',
    relations: role.relations ?? {},
    ooc_reaction: world.ooc_default ?? '当是对方在说胡话',
    examples: [],
    discretion: 'mid',
    server_only: { fate: role.fate, alertness: role.alert ? 'high' : 'mid', grudge: 'mid', major_secrets: [], foreshadow: [] },
  };
}

export const LEVEL_NUM: Record<'low' | 'mid' | 'high', number> = { low: 0.2, mid: 0.5, high: 0.8 };

/** 信任回升的倍率：记仇程度 × 难度 */
export function recoveryFactor(grudge: 'low' | 'mid' | 'high' | undefined, difficulty: DifficultyDef): number {
  const g = grudge === 'high' ? 0.6 : grudge === 'low' ? 1.3 : 1;
  const d = difficulty.server.trust_recovery === 'fast' ? 1.4 : difficulty.server.trust_recovery === 'slow' ? 0.6 : 1;
  return g * d;
}

/** 玩家输入的清洗（和 render.mjs 的 sanitizePlayerText 同一套规则：去掉各种括号、英文引号、反引号，半角冒号换全角，压掉换行） */
export function sanitizeText(s: string, max = 300): string {
  return String(s)
    .replace(/[「」『』【】{}<>\[\]"`]/g, '')
    .replace(/:/g, '：')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function promptPackLoaded() {
  return loaded;
}

/**
 * 开局时给每个 AI 角色挂上人设卡，并把卡上只给服务器的东西接进框架：
 * - server_only.fate → 角色的原著命运（只给说书人看）；
 * - server_only.foreshadow → 说书人的伏笔池（时机到了由说书人揭给相关的人）；
 * - secrets[].knowers → 知情人的 known_secrets（谣言从他们嘴里来）。
 */
export function attachCards(pack: PromptPack, scenario: Scenario, ais: { id: string; role?: RoleDef; card?: PersonaCard }[], world: PromptWorldFile) {
  for (const ai of ais) {
    if (!ai.role) continue;
    ai.card = pack.card(scenario.id, ai.role, world);
    if (!ai.role.fate && ai.card.server_only?.fate) ai.role.fate = ai.card.server_only.fate;
  }
  const secrets = (scenario.storyteller.secrets ??= []);
  for (const ai of ais) {
    const card = ai.card;
    if (!card) continue;
    for (const f of card.server_only?.foreshadow ?? []) {
      if (!f.reveal || secrets.some((s) => s.text === f.reveal)) continue;
      secrets.push({ text: f.reveal, involves: [card.id], when: f.when });
    }
    for (const sec of card.secrets ?? []) {
      for (const kid of sec.knowers ?? []) {
        const knower = ais.find((x) => x.id === kid)?.card;
        if (!knower || knower.id === card.id) continue;
        knower.known_secrets ??= [];
        if (!knower.known_secrets.some((k) => k.owner === card.id && k.text === sec.text)) knower.known_secrets.push({ owner: card.id, text: sec.text });
      }
    }
  }
}
