// 核心类型定义：方块世界、角色、动作、事件、观察、模型适配器、剧本、一局游戏

/** 整数格子坐标。x 向东增大，z 向南增大，y 向上增大 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Facing = 'north' | 'east' | 'south' | 'west';
export const FACINGS: Facing[] = ['north', 'east', 'south', 'west'];
export const FACING_VEC: Record<Facing, Vec3> = {
  north: { x: 0, y: 0, z: -1 },
  east: { x: 1, y: 0, z: 0 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
};
export const FACING_CN: Record<Facing, string> = { north: '北', east: '东', south: '南', west: '西' };

/** 地标：有名字的区域，供 AI 用名字寻路 */
export interface Landmark {
  id: string;
  name: string;
  pos: Vec3;
  radius: number;
  description: string;
}

// —— 模型与角色 ————————————————————————————————————————————

/** 一个可用的模型（models.json 里的一项） */
export interface ModelSpec {
  /** 适配器名：deepseek | doubao | qwen | kimi | zhipu | openai | anthropic | gemini | ollama | mock */
  provider: string;
  model?: string;
  /** 自定义 OpenAI 兼容服务时用 */
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  /** 价格（人民币元 / 百万 token）：in 输入未命中缓存、cached 输入命中缓存、out 输出。算每局花费用 */
  price?: { in: number; cached?: number; out: number };
  /** 额外塞进请求体的字段（OpenAI 兼容接口）：例如 DeepSeek 关掉思考模式 {"thinking":{"type":"disabled"}}；会覆盖预设里的同名字段 */
  extraBody?: Record<string, unknown>;
}

/** 一次模型调用的用量（适配器报上来，成本表累计） */
export interface Usage {
  provider: string;
  model?: string;
  promptTokens: number;
  /** 其中命中缓存的输入 token */
  cachedTokens: number;
  completionTokens: number;
}

/** 角色绑定到模型之后的完整配置（运行时用，兼容旧的 agents.config.json） */
export interface AgentConfig extends ModelSpec {
  id: string;
  name: string;
  color: string;
  /** 旧字段：一句话性格；新剧本用 role */
  personality: string;
  home?: string;
  /** 核心六人用好模型，路人用便宜模型 */
  tier?: 'core' | 'extra';
  role?: RoleDef;
  /** 人设卡（来自提示词线程的 prompts/ 目录；没有卡时由剧本角色生成一张简卡） */
  card?: PersonaCard;
}

/** 剧本里的一个角色：人设卡 */
export interface RoleDef {
  id: string;
  name: string;
  /** core = 和主角联系最密切的核心人物（用好一点的模型），extra = 路人 */
  tier: 'core' | 'extra';
  /** 公开身份，大家都知道 */
  public: string;
  /** 性格 */
  personality: string;
  /** 说话风格、口头禅 */
  speech?: string;
  /** 心愿：想要的东西 */
  wish: string;
  /** 心结：放不下的事 */
  knot: string;
  /** 和其他角色的关系（角色 id → 一句话） */
  relations?: Record<string, string>;
  /** 穿书模式：原著命运，AI 自己不知道，只给说书人看 */
  fate?: string;
  home?: string;
  color?: string;
  inventory?: Record<string, number>;
  /** 指定模型（不指定就按 tier 从 models.json 里分配） */
  model?: ModelSpec;
  /** 玩家可以扮演这个角色 */
  playable?: boolean;
  /** 性格警觉：偷听、偷他东西更容易被发现 */
  alert?: boolean;
}

// —— 剧本 ————————————————————————————————————————————————

/** 方块主题：按剧本改方块的名字和颜色 */
export type BlockTheme = Record<string, { cn?: string; color?: string }>;

export interface ScenarioLandmark {
  id: string; // 固定为 spawn | forest | quarry | sandpit | hill（对应地形生成的五个区域）
  name: string;
  description: string;
}

/** 说书人的设定 */
export interface StorytellerConfig {
  /** 活跃度：安静 / 正常 / 戏多 */
  activity: 'quiet' | 'normal' | 'dramatic';
  /** 剧本作者写的“可能长出来的故事”，给说书人当灵感，不是固定剧情 */
  seeds: string[];
  /** 随机事件池：说书人从里面抽，也可以自己编池子外的 */
  pool: string[];
  /** 一件迟早会来的大事（收网）：只给提示，具体形态由说书人根据前面发生的事决定 */
  bigEvent?: { hint: string; afterMinutes?: number; afterDay?: number };
  /** 固定骨架（开场、中段高潮……）或穿书模式的原著轨道：第几天发生什么，没人干预就按它走 */
  track?: { day: number; name: string; hint: string }[];
  /** 埋好的伏笔：由服务器保管，AI 不知道；说书人觉得时机到了才告诉相关角色 */
  secrets?: { text: string; involves: string[]; when?: string }[];
}

export interface Scenario {
  id: string;
  name: string;
  genre: 'modern' | 'ancient' | 'fantasy' | 'scifi' | 'book' | 'custom';
  tagline: string;
  /** 世界背景，给所有角色和说书人看 */
  background: string;
  /** 玩家是谁（默认玩家角色的介绍） */
  playerIntro?: string;
  /** 剧本模式一局多长：分钟数和游戏日数；沙盒模式忽略 */
  duration: { minutes: number; days: number };
  world: {
    seed?: number;
    /** 地图大小（格），x、z 各 48–160，不填用默认的 80×80 */
    size?: { x: number; z: number };
    theme?: BlockTheme;
    landmarks: ScenarioLandmark[];
    /** 偷东西被抓后关在哪个地标（默认 hill） */
    jail?: string;
  };
  roles: RoleDef[];
  /** 玩家角色模板（玩家可以改名字、心愿） */
  player: RoleDef;
  storyteller: StorytellerConfig;
  /** 被抓现行怎么罚（各剧本说法不同：报警 / 见捕头 / 上戒律堂 / 关禁闭 / 被回了太太） */
  penalties?: { steal: string; eavesdrop: string };
  /** 游戏币：叫什么（铜钱 / 灵石 / 元……）、开局给多少、托人打听一次花多少 */
  currency?: { name: string; start: number; askCost: number };
  /** 剧本特有的功能：现代剧本能发微信 */
  features?: { wechat?: boolean };
  /**
   * 核心六人按玩家扮演谁来定（穿书模式）：key 是玩家选的角色 id（'player' = 主角模板），value 是那六个人的 id。
   * 开局时命中的名单设为 core（用好模型），其余角色设为 extra；没命中就按角色里写的 tier
   */
  coreSets?: Record<string, string[]>;
}

/** 沙盒模式开局时玩家给的自定义设定 */
export interface SandboxOptions {
  /** 用一段话加设定，例如“把红楼梦搬到太空站” */
  customText?: string;
  /** 玩家捏的额外角色 */
  extraRoles?: RoleDef[];
  /** 不要的角色 id */
  removeRoles?: string[];
  storytellerActivity?: StorytellerConfig['activity'];
  /** 昼夜流速：现实 1 秒 = 游戏多少分钟 */
  minutesPerSecond?: number;
  disasters?: boolean;
  /** 玩家离开时世界是否继续运转 */
  runWhileAway?: boolean;
}

export interface GameOptions {
  scenarioId: string;
  mode: 'story' | 'sandbox';
  /** 玩家扮演哪个角色：'player' = 剧本给的主角模板，或任一 playable 角色 id；不填 = 观察模式 */
  playerRole?: string | null;
  playerName?: string;
  /** 玩家开局给自己定的心愿，可以不定 */
  playerWish?: string;
  sandbox?: SandboxOptions;
  seed?: number;
  /** 难度：宽厚 / 寻常 / 精明（角色多好骗、多警觉、多容易松口；不填 = normal） */
  difficulty?: Difficulty;
}

// —— 动作 ————————————————————————————————————————————————————

/** 挖/放方块的目标格：都在面前那一列 */
export type BlockTarget = 'front' | 'front_up' | 'front_down';

/** 模型返回的动作。新增动作类型时同时在 actions.ts 里注册处理器 */
export type Action =
  | { type: 'turn'; direction: Facing | 'left' | 'right' }
  | { type: 'move'; steps: number }
  | { type: 'walk_to'; target?: string; x?: number; z?: number }
  /** 走到某个人、某个地标或某个方块跟前并面向它 */
  | { type: 'approach'; target: string | Vec3 }
  | { type: 'break_block'; target: BlockTarget }
  | { type: 'place_block'; block: string; target: BlockTarget }
  | { type: 'say'; text: string; to?: string }
  /** 私聊：只有对方听得见（要在 2 格内），但附近偷听的人可能听到 */
  | { type: 'whisper'; to: string; text: string }
  /** 偷听附近正在说话的人，可能被发现 */
  | { type: 'eavesdrop'; target: string }
  /** 偷东西，可能被发现 */
  | { type: 'steal'; target: string; item?: string }
  /** 给东西 */
  | { type: 'give'; to: string; item: string; count?: number }
  /** 往面前的箱子里放 / 从箱子里取 */
  | { type: 'put'; item: string; count?: number }
  | { type: 'take'; item: string; count?: number }
  | { type: 'emote'; emote: string }
  | { type: 'idle'; seconds?: number }
  /** 花游戏币托人打听某人对你（或对别人）的看法：好感、信任、他记得的事 */
  | { type: 'ask_around'; target: string; about?: string }
  /** 传话：让跟前的人把一句话带给第三个人（带不带、带成什么样，看那个人） */
  | { type: 'pass_message'; via: string; to: string; text: string }
  /** 写信：信是身上的一件东西，可以亲手给、托人带、放箱子，也可能被偷、被拆 */
  | { type: 'write_letter'; to: string; text: string }
  /** 现代剧本：发微信，不用在跟前，别人听不到 */
  | { type: 'wechat'; to: string; text: string }
  | { type: 'read_letter'; item: string };

/** 模型一次决策的完整输出 */
export interface Decision {
  thought: string;
  /** 因为哪段记忆 / 谁的话才这么做（因果日志，结算时串蝴蝶效应链用） */
  because?: string;
  /** 当前打算（跨回合保持，下一回合会原样给回模型） */
  goal?: string;
  /** 这回合对谁的心情变了：id → "+原因" / "-原因"（好感加减） */
  feel?: Record<string, string>;
  action: Action;
}

// —— 人设卡与提示词模板（格式归“AI角色提示词”线程，见 prompts/schema/persona-card.schema.json） ——

export type Difficulty = 'easy' | 'normal' | 'hard';

/** 人设卡：除 server_only 外都会拼进系统提示词；server_only 由服务器保管 */
export interface PersonaCard {
  id: string;
  name: string;
  tier: 'core' | 'extra';
  identity: string;
  personality: string;
  wish: string;
  knot?: string;
  boundaries?: string;
  /** 小秘密：原文进提示词；knowers 不进，谣言从他们嘴里来 */
  secrets?: { text: string; knowers?: string[] }[];
  speech: { style: string; catchphrases?: string[]; sample_lines: string[]; taboo_words?: string[] };
  deception?: string;
  conflict?: string;
  relations?: Record<string, string>;
  ooc_reaction?: string;
  examples?: { input: string; output: Record<string, unknown> }[];
  model_hint?: string;
  /** true = 没有卡，框架从剧本角色生成的简卡 */
  generated?: boolean;
  /** 知道的别人的事，进提示词；配合 discretion 决定传不传 */
  known_secrets?: { owner: string; text: string }[];
  discretion?: 'low' | 'mid' | 'high';
  server_only?: {
    fate?: string;
    foreshadow?: { when: string; reveal: string }[];
    alertness?: 'low' | 'mid' | 'high';
    grudge?: 'low' | 'mid' | 'high';
    /** 要紧的秘密：只有 hint 进提示词，text 由服务器在条件满足时放进回合 */
    major_secrets?: { text: string; hint: string; knowers?: string[]; release_when: string }[];
  };
}

/** 一个剧本的世界描述文件（prompts/scenarios/<剧本>/world.json） */
export interface PromptWorldFile {
  scenario?: string;
  world: string;
  world_brief: string;
  taboo_words?: string[];
  ooc_default?: string;
  steal_penalty?: string;
}

// —— 运行时状态 ————————————————————————————————————————————

/** 对另一个人的印象 */
export interface Relation {
  /** 信任 -100..100：信不信这个人说的话 */
  trust: number;
  /** 好感 -100..100：喜不喜欢这个人 */
  affection: number;
  /** 具体记得的事（最多几条） */
  notes: string[];
  /** 被这个人骗过几次（自己觉出来的） */
  exposed?: number;
  /** 被同一个人拆穿两次谎之后：说什么都不信，要找人核实 */
  distrust?: boolean;
  /** 收过这个人几次礼（礼越送越不值钱） */
  gifts?: number;
}

/** 角色运行时状态 */
export interface AgentState {
  config: AgentConfig;
  /** 实际使用的模型标签（缺少 key 时会降级为 mock） */
  providerLabel: string;
  kind: 'ai' | 'player';
  alive: boolean;
  pos: Vec3; // 脚所在的格子
  facing: Facing;
  path: Vec3[]; // 还没走完的格子
  nextStepAt: number;
  /** 下一格被别人占着时已经等了多少个 tick，超过上限就绕路 */
  waitTicks: number;
  targetName: string | null;
  /** approach：到达后要面向的人（角色 id）或格子 */
  faceOnArrive: string | Vec3 | null;
  thinking: boolean;
  busyUntil: number; // 当前动作在这个时间戳前不再决策（ms）
  /** 有事发生时置 true，让它尽快思考（事件驱动唤醒） */
  wake: boolean;
  lastThought: string;
  lastAction: Action | null;
  /** 上一步的结果，给模型看 */
  lastResult: string;
  goal: string;
  emote: string | null;
  /** 最近感知到的事件（短期记忆） */
  memory: string[];
  /** 压缩后的长期记忆（每条是一段摘要） */
  longMemory: string[];
  /** 对每个人的印象 */
  relations: Record<string, Relation>;
  inventory: Record<string, number>; // 方块名/物品名 → 数量
  /** 心愿（会变） */
  wish: string;
  /** 警觉度 0..1：越高越容易发现偷听/偷东西的人 */
  alertness: number;
  /** 信任回升的快慢（1 = 寻常；记仇的人和“精明”难度下更小） */
  recovery: number;
  /** 别人亲口对我说过的话（原话，服务器保存不压缩）：对方 id → 最近几句 */
  claims: Record<string, string[]>;
  /** 服务器已经释放给我的要紧秘密 / 往事（每回合都放进【只有你知道的事】） */
  released: string[];
  /** 此刻的状态（气头上、被关着……），到 until 为止 */
  mood: { text: string; until: number } | null;
  /** 受罚：被关起来到什么时候（ms 时间戳），0 = 没被关 */
  jailedUntil: number;
  /** 偷东西/偷听得手、被抓的次数（结算卡用） */
  stats: { steals: number; caught: number; gives: number; whispers: number; says: number };
  /** 正在偷听谁（偷听持续一段时间） */
  eavesdropping: string | null;
  eavesdropUntil: number;
}

/** 推送给前端、也写入角色记忆的世界事件 */
export type WorldEvent =
  | { kind: 'say'; t: number; agentId: string; text: string; to?: string }
  /** relayTo：这是托对方带给第三人的话（pass_message），text 是原话；对方照传、改字还是压下，看他之后自己说什么 */
  | { kind: 'whisper'; t: number; agentId: string; to: string; text: string; overheardBy?: string[]; relayTo?: string }
  /** 微信：只有收发双方看到 */
  | { kind: 'wechat'; t: number; agentId: string; to: string; text: string }
  /** 读信：agentId 是读信的人（收信人，或拆别人信的人），只有他看到 */
  /** agentId 是读信的人；via 是经手人（替作者转交的人，或 'chest' = 从箱子里取的） */
  | { kind: 'letter'; t: number; agentId: string; from: string; to: string; text: string; item: string; via?: string }
  | { kind: 'emote'; t: number; agentId: string; emote: string }
  | { kind: 'move'; t: number; agentId: string; target: string }
  | { kind: 'arrive'; t: number; agentId: string; target: string }
  | { kind: 'block'; t: number; agentId: string; op: 'break' | 'place'; block: string; pos: Vec3 }
  | { kind: 'give'; t: number; agentId: string; to: string; item: string; count: number }
  | { kind: 'chest'; t: number; agentId: string; op: 'put' | 'take'; item: string; count: number; pos: Vec3 }
  /** 偷东西/偷听得手（只有当事人自己知道） */
  | { kind: 'sneak'; t: number; agentId: string; what: 'steal' | 'eavesdrop'; target: string; item?: string; text?: string }
  /** 被抓现行：当众揭穿 */
  | { kind: 'caught'; t: number; agentId: string; what: 'steal' | 'eavesdrop'; target: string; by: string; penalty: string }
  | { kind: 'fail'; t: number; agentId: string; text: string }
  /** 只有当事人知道的私下消息：发觉东西丢了、说书人悄悄告诉的往事 */
  | { kind: 'notice'; t: number; agentId: string; text: string }
  | { kind: 'thought'; t: number; agentId: string; text: string; because?: string }
  | { kind: 'error'; t: number; agentId: string; text: string }
  /** 说书人投放的事件 */
  | { kind: 'story'; t: number; title: string; text: string; participants?: string[]; requestedBy?: string }
  /** 章回回顾（每个游戏日结束时） */
  | { kind: 'chapter'; t: number; day: number; title: string; text: string }
  /** 一局结束 */
  | {
      kind: 'ending';
      t: number;
      title: string;
      text: string;
      epilogues?: { id: string; name: string; text: string }[];
      /** 蝴蝶效应链：玩家的一个小举动引出的连锁反应，按时间一幕幕（最多 5 幕），给结算动画用 */
      chain?: { text: string }[];
      /** 感人的揭晓“原来是这样”：最多一两段，条件不够就没有 */
      reveals?: { title: string; text: string; participants: string[] }[];
    }
  /** 游戏流程：天亮、中午、傍晚、入夜、开局、结束 */
  | { kind: 'game'; t: number; text: string; day: number; phase: GamePhase; audience?: 'all' | 'player' }
  /** 一次性注释：天亮、中午、傍晚、入夜等公告见 game；下面是系统消息 */
  | { kind: 'system'; t: number; text: string };

/** 一个游戏日四段：早上、中午、傍晚、夜里（剧情模式 3 天 × 4 段 × 5 分钟 = 60 分钟） */
export type GamePhase = 'morning' | 'noon' | 'evening' | 'night';

/** 交给模型的观察结果：一段文字描述 + 结构化数据 */
export interface Observation {
  time: string;
  day: number;
  phase: GamePhase;
  self: {
    id: string;
    name: string;
    position: Vec3;
    facing: Facing;
    standing_on: string;
    /** 面前那一列三个格子里是什么（中文方块名） */
    front: { feet: string; head: string; ground: string };
    inventory: Record<string, number>;
    moving_to: string | null;
    goal: string;
    last_result: string;
    wish: string;
  };
  /** 感知层生成的自然语言描述 */
  scene: string;
  nearby_agents: { id: string; name: string; direction: string; distance: number; position: Vec3; emote: string | null; trust: number }[];
  notable_blocks: { block: string; direction: string; distance: number; position: Vec3 }[];
  landmarks: { id: string; name: string; direction: string; distance: number }[];
  heard: string[]; // 最近听到的话
  memory: string[]; // 最近记忆
  long_memory: string[]; // 长期记忆摘要
  /** 对有过来往的人的印象（“某人：有好感（送了我东西）”） */
  relations: string[];
}

export interface DecideInput {
  agent: AgentConfig;
  system: string;
  prompt: string;
  observation?: Observation;
  /** 输出上限（token），每次只许回几句话 */
  maxTokens?: number;
  /** 要求 JSON 输出 */
  json?: boolean;
  /** 采样温度（核心 1.0、配角 0.8、记忆摘要 0.3；不填由适配器默认） */
  temperature?: number;
  /** 适配器把这次调用的用量报上来（算每局花费） */
  onUsage?: (u: Usage) => void;
}

/**
 * 模型适配器：所有模型统一实现这个接口。
 * 返回原始文本，由 prompt.ts 统一解析成 Decision。
 */
export interface ModelAdapter {
  readonly provider: string;
  /** 适配器对这个角色是否可用（例如有没有 API key；openai 兼容服务要看角色自己的 apiKeyEnv/baseUrlEnv） */
  available(agent?: AgentConfig): boolean;
  decide(input: DecideInput): Promise<string>;
}
