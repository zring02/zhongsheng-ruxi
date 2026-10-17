import { actionDocs, blockedByAgents, chestKey, DEFAULT_DOC_OPTS, facingToward, freeSpotNear, getHandler, isOccupied, itemName, type ActionContext } from './actions.js';
import type { BudgetLevel } from './cost.js';
import { resolveAdapter } from './adapters/index.js';
import { addClaim, adjustAffection, adjustTrust, compactMemory, describeFeeling, needsCompaction, noteExposure, remember, spreadRumors, stripStamp } from './memory.js';
import { buildObservation, cheb, nearestLandmark, PHASE_CN } from './perception.js';
import { difficultyDef, LEVEL_NUM, recoveryFactor, sanitizeText, type DifficultyDef, type PromptPack, type TurnData } from './persona.js';
import { buildSystemPrompt, buildSystemPromptFromCard, buildTurnPrompt, buildUserPrompt, compactScene, parseDecision, type PromptWorld } from './prompt.js';
import type { Action, AgentConfig, AgentState, Facing, GamePhase, Landmark, ModelAdapter, ModelSpec, Observation, PersonaCard, PromptWorldFile, RoleDef, Scenario, ScenarioLandmark, Usage, Vec3, WorldEvent } from './types.js';
import { BLOCK, blockById, generateWorld, type VoxelWorld } from './voxel.js';

const TICK_MS = 100;
const STEP_MS = 350; // 走一格的时间
const EVENT_LOG_LIMIT = 300;
const HEARING_RADIUS = 10;
/** 私聊时旁边几格内的人能看到你们在说悄悄话、可能听去几个字 */
const WHISPER_LEAK_RADIUS = 3;
/** 下一格被人占着时最多等多少个 tick，之后把那格当障碍重新寻路 */
const MAX_WAIT_TICKS = 10;
/** 每个角色两次决策之间的最短间隔的默认值（实际值在构造时读环境变量，见 decisionIntervalMs） */
const DEFAULT_DECISION_INTERVAL_MS = 2000;
/** 没事发生时多久想一次：核心人物 ×3，路人 ×6（有事才想，省钱） */
const IDLE_FACTOR = { core: 3, extra: 6 };
const DEFAULT_INVENTORY: Record<string, number> = { plank: 4 };

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  id: number;
}

export interface SimOptions {
  seed: number;
  /** 地图大小（格），不填用默认 */
  size?: { x: number; z: number };
  /** 剧本给五个地标起的名字 */
  landmarks: ScenarioLandmark[];
  ais: AgentConfig[];
  player: AgentConfig | null;
  background: string;
  genre: Scenario['genre'];
  penalties: { steal: string; eavesdrop: string };
  /** 关人的地标 id */
  jailLandmark: string;
  maxTokens: { core: number; extra: number };
  /** 记忆压缩用的便宜模型：适配器 + 这个模型自己的型号参数（没有就用角色自己的模型，再没有就用规则摘要） */
  memoryAdapter?: ModelAdapter | null;
  memorySpec?: ModelSpec | null;
  rnd?: () => number;
  /** 提示词包（模板 + 渲染器）；没有就用内置占位提示词 */
  promptPack?: PromptPack | null;
  /** 本剧本的世界描述（给人设卡模板用） */
  worldFile?: PromptWorldFile;
  /** 难度（被发现概率、秘密松口门槛、信任回升快慢） */
  difficulty?: DifficultyDef;
  /** 游戏币：叫什么、开局给多少、托人打听一次花多少 */
  currency?: { name: string; start: number; askCost: number };
  /** 剧本开了哪些功能（现代剧本有微信） */
  features?: { wechat: boolean };
  /** 每次模型调用的用量报到这里（算每局花费） */
  onUsage?: (u: Usage) => void;
  /** 当前预算档位：ok 正常；saving 配角没事不想、核心人物发呆间隔加倍；over 全部改用 mock */
  budgetLevel?: () => BudgetLevel;
  /** 给每个角色的适配器套一层（调用记录用）；预算用完换成 mock 时也会套 */
  wrapAdapter?: (adapter: ModelAdapter, config: AgentConfig) => ModelAdapter;
}

export interface Clock {
  time: string;
  day: number;
  phase: GamePhase;
}

type EventListener = (ev: WorldEvent) => void;
type BlockListener = (changes: BlockChange[]) => void;

interface Runtime {
  state: AgentState;
  adapter: ModelAdapter | null;
  system: string;
  heard: string[];
  lastDecisionAt: number;
  maxTokens: number;
  temperature: number;
  card: PersonaCard | null;
  /** 这回合为什么叫醒它（回合提示词最后一行的 trigger） */
  wakeReason: string;
  /** 上回合思考时短期记忆有多长：之后新进的条目就是【刚发生的事】 */
  memoryMark: number;
  /** 连续出错（超时、接口报错）次数；到 FAIL_LIMIT 就临时换 mock，MOCK_COOLDOWN_MS 后再试真模型 */
  failures?: number;
  /** 临时换成 mock 期间，真模型的适配器放这儿，到点换回来 */
  realAdapter?: ModelAdapter | null;
  mockUntil?: number;
}

/** 真模型连续失败几次就临时改用内置 mock；多久以后再试真模型 */
const FAIL_LIMIT = 3;
const MOCK_COOLDOWN_MS = 120_000;

interface QueuedAction {
  agentId: string;
  action: Action;
  /** 玩家的动作会打断正在走的路 */
  interrupt: boolean;
}

/**
 * 模拟器：每个角色独立跑 perceive → decide → act 循环。
 * 世界以 10Hz 推进（走路、重力、定时器、动作队列）；AI 角色有事（被搭话、有人走近、剧情事件）就尽快思考，
 * 没事就隔较长时间才想一次；玩家的动作走同一条动作队列。
 */
export class Simulation {
  readonly world: VoxelWorld;
  readonly landmarks: Landmark[];
  readonly runtimes: Runtime[];
  readonly events: WorldEvent[] = [];
  readonly chests = new Map<string, Record<string, number>>();
  paused = false;
  /** 一局结束后冻结：不再决策、不再执行动作 */
  frozen = false;
  clock: Clock = { time: '06:00', day: 1, phase: 'morning' };
  elapsedMs = 0;
  private eventListeners = new Set<EventListener>();
  private blockListeners = new Set<BlockListener>();
  private tickListeners = new Set<(elapsedMs: number, now: number) => void>();
  private pendingBlocks: BlockChange[] = [];
  private queue: QueuedAction[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private timer?: NodeJS.Timeout;
  readonly rnd: () => number;
  readonly decisionIntervalMs: number;
  readonly difficulty: DifficultyDef;
  /** 写好的信：东西名 → 内容 */
  /** 托人打听、还没回话的（不存档，读档后可以重新打听） */
  readonly pendingAsks = new Set<string>();
  readonly letters = new Map<string, { from: string; to: string; text: string }>();
  private readonly memoryAdapter: ModelAdapter | null;

  constructor(readonly opts: SimOptions) {
    const interval = Number(process.env.DECISION_INTERVAL_MS);
    this.decisionIntervalMs = Number.isFinite(interval) && process.env.DECISION_INTERVAL_MS?.trim() ? Math.max(0, interval) : DEFAULT_DECISION_INTERVAL_MS;
    this.rnd = opts.rnd ?? Math.random;
    this.memoryAdapter = opts.memoryAdapter ?? null;
    this.difficulty = opts.difficulty ?? difficultyDef('normal');
    const { world, landmarks } = generateWorld(opts.seed, opts.size ?? {});
    this.world = world;
    this.landmarks = landmarks.map((l) => {
      const o = opts.landmarks.find((x) => x.id === l.id);
      return o ? { ...l, name: o.name, description: o.description || l.description } : l;
    });
    this.placeChests();
    const all = [...opts.ais, ...(opts.player ? [opts.player] : [])];
    const nameOf = (id: string) => all.find((c) => c.id === id)?.name ?? id;
    const docs = actionDocs({ features: opts.features ?? DEFAULT_DOC_OPTS.features, currency: opts.currency ?? DEFAULT_DOC_OPTS.currency });
    const promptWorld: PromptWorld = { background: opts.background, genre: opts.genre, landmarks: this.landmarks, nameOf, actions: docs };
    // 有提示词包（模板 + 人设卡）就用它拼系统提示词；没有就用内置占位提示词
    const pack = opts.promptPack ?? null;
    const names: Record<string, string> = Object.fromEntries(all.map((c) => [c.id, c.name]));
    const roster = all.map((c) => c.id);
    const playerRef = opts.player ? { id: opts.player.id, name: opts.player.name } : undefined;
    this.runtimes = [];
    for (const c of opts.ais) {
      const { adapter, fallback, reason } = resolveAdapter(c);
      const label = fallback ? `${c.provider}→mock` : c.provider;
      if (fallback) console.warn(`[${c.name}] ${c.provider} ${reason === 'unknown' ? '不是已知的 provider' : '未配置 key 或所需环境变量'}，暂用 mock 模型代替`);
      const card = pack && c.card && opts.worldFile ? c.card : null;
      const system = card ? buildSystemPromptFromCard(pack!, card, opts.worldFile!, { actions: docs, roster, player: playerRef, names, difficulty: this.difficulty.level }) : buildSystemPrompt(c, promptWorld);
      this.runtimes.push({
        state: this.spawn(c, label, 'ai'),
        adapter: opts.wrapAdapter ? opts.wrapAdapter(adapter, c) : adapter,
        system,
        heard: [],
        lastDecisionAt: 0,
        maxTokens: opts.maxTokens[c.tier ?? 'extra'],
        temperature: c.tier === 'core' ? 0.95 : 0.8,
        card,
        wakeReason: '',
        memoryMark: 0,
      });
    }
    if (opts.player) this.runtimes.push({ state: this.spawn(opts.player, '玩家', 'player'), adapter: null, system: '', heard: [], lastDecisionAt: 0, maxTokens: 0, temperature: 0, card: null, wakeReason: '', memoryMark: 0 });
  }

  /** 某个角色当前的系统提示词（调试、算 token 用） */
  systemPromptOf(agentId: string): string | undefined {
    return this.runtimes.find((r) => r.state.config.id === agentId)?.system;
  }

  get agents() {
    return this.runtimes.map((r) => r.state);
  }

  get player(): AgentState | null {
    return this.runtimes.find((r) => r.state.kind === 'player')?.state ?? null;
  }

  agent(id: string): AgentState | undefined {
    return this.runtimes.find((r) => r.state.config.id === id)?.state;
  }

  nameOf(id: string): string {
    return this.agent(id)?.config.name ?? id;
  }

  /** 每个地标旁放一个箱子，里面放几块木板 */
  private placeChests() {
    for (const l of this.landmarks) {
      const spot = this.world.findGroundSpot(l.pos.x + 2, l.pos.z + 1, 3, (x, z) => !(x === l.pos.x && z === l.pos.z));
      if (!spot) continue;
      this.world.set(spot.x, spot.y, spot.z, BLOCK.chest);
      this.chests.set(chestKey(spot), { plank: 3 });
    }
  }

  /** 在出生地标附近找一个能站的格子 */
  private spawn(config: AgentConfig, providerLabel: string, kind: 'ai' | 'player'): AgentState {
    const home = this.landmarks.find((l) => l.id === (config.home ?? config.role?.home)) ?? this.landmarks[0];
    const taken = (x: number, z: number) => this.agents.some((a) => a.pos.x === x && a.pos.z === z);
    let pos: Vec3 | null = null;
    for (let i = 0; i < 30 && !pos; i++) {
      const x = home.pos.x + Math.round((this.rnd() - 0.5) * home.radius);
      const z = home.pos.z + Math.round((this.rnd() - 0.5) * home.radius);
      if (!this.world.inBounds(x, 0, z) || !this.world.isGroundSpot(x, z) || taken(x, z)) continue;
      pos = { x, y: this.world.surfaceY(x, z), z };
    }
    // 随机 30 次都没找到，就从地标中心螺旋向外找一个没人的格子，而不是直接站到中心叠在别人身上
    pos ??= this.world.findGroundSpot(home.pos.x, home.pos.z, home.radius + 2, (x, z) => !taken(x, z)) ?? { ...home.pos };
    const role = config.role;
    return {
      config,
      providerLabel,
      kind,
      alive: true,
      pos,
      facing: (['north', 'east', 'south', 'west'] as Facing[])[Math.floor(this.rnd() * 4)],
      path: [],
      nextStepAt: 0,
      waitTicks: 0,
      targetName: null,
      faceOnArrive: null,
      thinking: false,
      busyUntil: 0,
      wake: true,
      lastThought: '',
      lastAction: null,
      lastResult: '',
      goal: '',
      emote: null,
      memory: [],
      longMemory: [],
      relations: {},
      inventory: this.startingInventory(role, kind),
      wish: config.card?.wish ?? role?.wish ?? '',
      // 警觉：人设卡 server_only.alertness（low/mid/high）优先，其次剧本角色的 alert
      alertness: config.card?.server_only?.alertness ? LEVEL_NUM[config.card.server_only.alertness] : role?.alert ? 0.7 : 0.3,
      recovery: recoveryFactor(config.card?.server_only?.grudge, this.difficulty),
      claims: {},
      released: [],
      mood: null,
      jailedUntil: 0,
      eavesdropping: null,
      eavesdropUntil: 0,
      stats: { steals: 0, caught: 0, gives: 0, whispers: 0, says: 0 },
    };
  }

  /** 开局身上的东西：角色卡写的 + 本剧本的游戏币（玩家给足额，居民给一半，身上本来就有就不加） */
  private startingInventory(role: RoleDef | undefined, kind: 'ai' | 'player'): Record<string, number> {
    const inv: Record<string, number> = { ...(role?.inventory ?? DEFAULT_INVENTORY) };
    const cur = this.opts.currency;
    if (cur && cur.start > 0 && !(cur.name in inv)) inv[cur.name] = kind === 'player' ? cur.start : Math.max(1, Math.round(cur.start / 2));
    return inv;
  }

  onEvent(fn: EventListener) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onBlocks(fn: BlockListener) {
    this.blockListeners.add(fn);
    return () => this.blockListeners.delete(fn);
  }

  /** 每个 tick 开头调用（GameSession 用它推进游戏时钟、调度说书人） */
  onTick(fn: (elapsedMs: number, now: number) => void) {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  setBlock(pos: Vec3, id: number) {
    if (!this.world.set(pos.x, pos.y, pos.z, id)) return;
    this.pendingBlocks.push({ ...pos, id });
  }

  /** 过一会儿做一件事（跟着模拟时间走，暂停时也暂停） */
  later(ms: number, fn: () => void) {
    this.timers.push({ at: this.elapsedMs + ms, fn });
  }

  /** 让某人尽快思考 */
  wake(agentId: string) {
    const a = this.agent(agentId);
    if (a && a.kind === 'ai') a.wake = true;
  }

  /** 玩家（或别的外部来源）投一个动作进队列 */
  enqueue(agentId: string, action: Action, interrupt = false) {
    const a = this.agent(agentId);
    if (!a || !a.alive) return false;
    // 玩家连点时只保留最后一个
    if (interrupt) this.queue = this.queue.filter((q) => q.agentId !== agentId);
    this.queue.push({ agentId, action, interrupt });
    return true;
  }

  private tick() {
    if (this.paused || this.frozen) return;
    const now = Date.now();
    this.elapsedMs += TICK_MS;
    for (const fn of this.tickListeners) fn(this.elapsedMs, now);
    this.runTimers();
    this.applyGravity();
    this.stepPaths(now);
    this.drainQueue(now);
    for (const r of this.runtimes) {
      const a = r.state;
      if (!a.alive) continue;
      if (a.emote && now >= a.busyUntil) a.emote = null;
      if (a.eavesdropping && a.eavesdropUntil <= now) a.eavesdropping = null;
      if (a.jailedUntil && a.jailedUntil <= now) {
        a.jailedUntil = 0;
        this.emit({ kind: 'notice', t: now, agentId: a.config.id, text: '你被放出来了。' });
        a.wake = true;
      }
      if (a.kind !== 'ai' || !r.adapter) continue;
      if (a.thinking || a.path.length || now < a.busyUntil) continue;
      // 预算：花到八成，配角没事不想、核心人物发呆间隔加倍；花完，所有人改用 mock（零成本）继续过日子
      const level = this.opts.budgetLevel?.() ?? 'ok';
      if (level === 'over' && (r.adapter.provider !== 'mock' || r.realAdapter)) {
        const mock = resolveAdapter({ ...a.config, provider: 'mock', model: undefined }).adapter;
        r.adapter = this.opts.wrapAdapter ? this.opts.wrapAdapter(mock, a.config) : mock;
        r.realAdapter = null;
        r.mockUntil = undefined;
        a.providerLabel = `${a.config.provider}→mock(预算)`;
      }
      if (level === 'saving' && a.config.tier !== 'core' && !a.wake && r.adapter.provider !== 'mock') continue;
      // 真模型连续超时/报错后临时用 mock 过渡，冷却期满换回真模型再试（接口排队严重时整局不会卡住）
      if (r.realAdapter && r.mockUntil !== undefined && now >= r.mockUntil && level !== 'over') {
        r.adapter = r.realAdapter;
        r.realAdapter = null;
        r.mockUntil = undefined;
        r.failures = 0;
        a.providerLabel = a.config.provider;
        console.log(`[${a.config.name}] 冷却结束，换回 ${a.config.provider}`);
      }
      // 夜里大多数人睡了：配角没人叫就不想事（显示睡着），核心人物发呆间隔加倍；有人来搭话照样醒
      const night = this.clock.phase === 'night' && !a.wake && !a.jailedUntil;
      if (night && a.config.tier !== 'core') {
        a.emote = 'sleep';
        continue;
      }
      const idle = this.decisionIntervalMs * IDLE_FACTOR[a.config.tier ?? 'extra'] * (a.jailedUntil ? 2 : 1) * (level === 'saving' ? 2 : 1) * (night ? 2 : 1);
      const gap = a.wake ? Math.max(this.decisionIntervalMs, 1500) : idle;
      if (now - r.lastDecisionAt < gap) continue;
      void this.think(r);
    }
    this.flushBlocks();
  }

  private runTimers() {
    if (!this.timers.length) return;
    const due = this.timers.filter((t) => t.at <= this.elapsedMs);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.at > this.elapsedMs);
    for (const t of due) {
      try {
        t.fn();
      } catch (err) {
        console.warn('[sim] 定时任务出错:', (err as Error).message);
      }
    }
  }

  /** 脚下被挖空就往下掉；被方块埋住就往上顶 */
  private applyGravity() {
    const w = this.world;
    for (const a of this.agents) {
      const p = a.pos;
      if (w.isSolid(p.x, p.y, p.z) || w.isSolid(p.x, p.y + 1, p.z)) {
        let y = p.y;
        while (y < w.size.y - 2 && (w.isSolid(p.x, y, p.z) || w.isSolid(p.x, y + 1, p.z))) y++;
        a.pos = { ...p, y };
      } else if (p.y > 1 && !w.isSolid(p.x, p.y - 1, p.z)) {
        a.pos = { ...p, y: p.y - 1 };
      }
    }
  }

  /** 沿路径一格一格走；路被改了就重新寻路；下一格有人站着就先等一等，等久了绕路 */
  private stepPaths(now: number) {
    for (const a of this.agents) {
      if (!a.path.length || now < a.nextStepAt) continue;
      // 正在走向某个人，而他已经走开了：改道朝他现在的位置走
      if (typeof a.faceOnArrive === 'string') {
        const who = this.agent(a.faceOnArrive);
        const end = a.path[a.path.length - 1];
        if (who && cheb(who.pos, end) > 1) {
          const np = this.world.findPath(a.pos, who.pos, 1, 30000, blockedByAgents(this.agents, a));
          if (np) a.path = np;
          if (!a.path.length) {
            this.finishPath(a, now, true);
            continue;
          }
        }
      }
      const next = a.path[0];
      const reachable = this.world.canStand(next.x, next.y, next.z) && cheb(next, a.pos) <= 1 && Math.abs(next.y - a.pos.y) <= 1;
      const occupied = reachable && isOccupied(this.agents, a, next);
      if (occupied && a.waitTicks < MAX_WAIT_TICKS) {
        a.waitTicks++;
        continue;
      }
      if (!reachable || occupied) {
        // 走不过去（地形变了 / 等太久）：把别人站着的格子当障碍重新寻路
        a.waitTicks = 0;
        const goal = a.path[a.path.length - 1];
        const np = this.world.findPath(a.pos, goal, 3, 30000, blockedByAgents(this.agents, a));
        if (!np) {
          this.emit({ kind: 'fail', t: now, agentId: a.config.id, text: `路被${occupied ? '人' : ''}挡住了，到不了${a.targetName ?? '目的地'}` });
          this.finishPath(a, now, false);
          continue;
        }
        a.path = np;
        if (!np.length) this.finishPath(a, now, true);
        continue;
      }
      a.waitTicks = 0;
      a.path.shift();
      if (next.x !== a.pos.x || next.z !== a.pos.z) a.facing = facingToward(a.pos, next);
      a.pos = next;
      a.nextStepAt = now + STEP_MS;
      if (!a.path.length) this.finishPath(a, now, true);
    }
  }

  private finishPath(a: AgentState, now: number, arrived: boolean) {
    if (arrived) {
      if (a.faceOnArrive) {
        const target = typeof a.faceOnArrive === 'string' ? this.agent(a.faceOnArrive)?.pos : a.faceOnArrive;
        if (target && (target.x !== a.pos.x || target.z !== a.pos.z)) a.facing = facingToward(a.pos, target);
        // 走到人跟前：对方也会注意到你
        if (typeof a.faceOnArrive === 'string') this.wake(a.faceOnArrive);
      }
      this.emit({ kind: 'arrive', t: now, agentId: a.config.id, target: a.targetName ?? '' });
    }
    a.path = [];
    a.waitTicks = 0;
    a.targetName = null;
    a.faceOnArrive = null;
    a.busyUntil = now;
  }

  private flushBlocks() {
    if (!this.pendingBlocks.length) return;
    const changes = this.pendingBlocks;
    this.pendingBlocks = [];
    for (const fn of this.blockListeners) fn(changes);
  }

  private makeContext(now: number): ActionContext {
    return {
      now,
      world: this.world,
      agents: this.agents,
      landmarks: this.landmarks,
      phase: this.clock.phase,
      chests: this.chests,
      penalties: this.opts.penalties,
      detectDelta: this.difficulty.server.detect_delta,
      currency: this.opts.currency ?? { name: DEFAULT_DOC_OPTS.currency.name, start: 0, askCost: DEFAULT_DOC_OPTS.currency.askCost },
      features: this.opts.features ?? DEFAULT_DOC_OPTS.features,
      letters: this.letters,
      nameOf: (id) => this.nameOf(id),
      hear: (id, line, reason) => this.hear(id, line, reason),
      rnd: this.rnd,
      emit: (ev) => this.emit(ev),
      setBlock: (pos, id) => this.setBlock(pos, id),
      wake: (id) => this.wake(id),
      trust: (a, other, delta, note) => {
        adjustTrust(a, other, delta, note);
        // 信任大跌（被偷、被骗、被撞见）：人会在气头上一阵，这时候更容易说漏嘴
        if (delta <= -25) a.mood = { text: '你正在气头上', until: now + 120_000 };
      },
      jail: (agent, ms) => this.jail(agent, ms, now),
      later: (ms, fn) => this.later(ms, fn),
      pendingAsks: this.pendingAsks,
    };
  }

  /** 执行队列里的动作（AI 的决策和玩家的输入都从这里走，按先后顺序） */
  private drainQueue(now: number) {
    if (!this.queue.length) return;
    const items = this.queue;
    this.queue = [];
    for (const q of items) {
      const a = this.agent(q.agentId);
      if (!a || !a.alive) continue;
      if (q.interrupt && a.path.length) this.finishPath(a, now, false);
      else if (a.path.length) {
        this.queue.push(q); // 还在走，等走完再做
        continue;
      }
      this.applyAction(a, q.action, now);
    }
  }

  private applyAction(a: AgentState, action: Action, now: number) {
    const handler = getHandler(action.type);
    if (!handler) return;
    if (a.jailedUntil > now && !handler.allowedInJail) {
      this.emit({ kind: 'fail', t: now, agentId: a.config.id, text: `被关着，做不了 ${action.type}` });
      a.busyUntil = now + 1500;
      return;
    }
    a.lastAction = action;
    const busyMs = handler.apply(this.makeContext(now), a, action);
    a.busyUntil = now + (Number.isFinite(busyMs) ? busyMs : 0);
    this.flushBlocks();
  }

  /** 关押：押到关人的地标旁，一段时间内只能说话发呆 */
  private jail(a: AgentState, ms: number, now: number) {
    const lm = this.landmarks.find((l) => l.id === this.opts.jailLandmark) ?? this.landmarks[this.landmarks.length - 1];
    const spot = freeSpotNear(this, a, lm.pos.x, lm.pos.z, 3);
    a.path = [];
    a.targetName = null;
    a.faceOnArrive = null;
    a.pos = { x: spot.x, y: this.world.surfaceY(spot.x, spot.z), z: spot.z };
    a.jailedUntil = now + ms;
    a.eavesdropping = null;
    a.mood = { text: '你被关着，又气又怕，出不去', until: now + ms };
    this.emit({ kind: 'notice', t: now, agentId: a.config.id, text: `你被带到了${lm.name}关起来，${Math.round(ms / 1000)} 秒后才放出来。` });
  }

  /** 记一次接口失败（超时、报错、空回复、不成 JSON）；连续 FAIL_LIMIT 次就临时换 mock，冷却后再换回真模型 */
  private noteFailure(r: Runtime) {
    const a = r.state;
    r.failures = (r.failures ?? 0) + 1;
    if (r.failures < FAIL_LIMIT || !r.adapter || r.adapter.provider === 'mock' || r.realAdapter) return;
    const mock = resolveAdapter({ ...a.config, provider: 'mock', model: undefined }).adapter;
    r.realAdapter = r.adapter;
    r.adapter = this.opts.wrapAdapter ? this.opts.wrapAdapter(mock, a.config) : mock;
    r.mockUntil = Date.now() + MOCK_COOLDOWN_MS;
    a.providerLabel = `${a.config.provider}→mock(接口连续出错)`;
    a.busyUntil = Date.now() + 2000;
    console.warn(`[${a.config.name}] ${a.config.provider} 连续 ${r.failures} 次出错，先用 mock 过渡 ${MOCK_COOLDOWN_MS / 1000} 秒`);
  }

  /** perceive → decide → 投进动作队列 */
  private async think(r: Runtime) {
    const a = r.state;
    a.thinking = true;
    a.wake = false;
    r.lastDecisionAt = Date.now();
    try {
      const now0 = Date.now();
      const heard = r.heard.splice(0);
      const observation = buildObservation(this.world, this.landmarks, this.agents, a, heard, { ...this.clock, now: now0 });
      // 有人设卡：按提示词线程的回合模板拼；没有：内置的场景描述 + 结构化观察
      const prompt = r.card && this.opts.promptPack ? buildTurnPrompt(this.opts.promptPack, r.card, this.turnData(r, observation, heard, now0)) : buildUserPrompt(observation);
      r.memoryMark = a.memory.length;
      r.wakeReason = '';
      const text = await r.adapter!.decide({ agent: a.config, system: r.system, prompt, observation, maxTokens: r.maxTokens, json: true, temperature: r.temperature, onUsage: this.opts.onUsage });
      if (this.frozen) return;
      const parsed = parseDecision(text);
      if (parsed.error !== undefined) {
        if (parsed.fatal) {
          // 连 JSON 都抠不出来（包括空回复）：记 error（模型看不到），算一次接口失败，歇 3 秒再试
          this.emit({ kind: 'error', t: Date.now(), agentId: a.config.id, text: `无法解析模型输出(${parsed.error}): ${text.slice(0, 120) || '（空）'}` });
          a.busyUntil = Date.now() + 3000;
          this.noteFailure(r);
        } else {
          r.failures = 0;
          // JSON 没问题但动作不合法：用 fail 事件告诉角色自己原因，下回合它才有机会改正，不会原地死循环
          if (parsed.thought) {
            a.lastThought = parsed.thought;
            this.emit({ kind: 'thought', t: Date.now(), agentId: a.config.id, text: parsed.thought });
          }
          this.emit({ kind: 'fail', t: Date.now(), agentId: a.config.id, text: `动作不合法，${parsed.error}` });
          a.busyUntil = Date.now() + 1500;
        }
        return;
      }
      const { decision } = parsed;
      a.lastThought = decision.thought;
      if (decision.goal) a.goal = decision.goal;
      this.applyFeel(a, decision.feel);
      if (decision.thought) this.emit({ kind: 'thought', t: Date.now(), agentId: a.config.id, text: decision.thought, because: decision.because });
      this.enqueue(a.config.id, decision.action);
      r.failures = 0;
    } catch (err) {
      this.emit({ kind: 'error', t: Date.now(), agentId: a.config.id, text: String((err as Error).message ?? err).slice(0, 200) });
      a.busyUntil = Date.now() + 10_000; // 出错后歇一会儿再试
      this.noteFailure(r);
    } finally {
      a.thinking = false;
      if (needsCompaction(a)) {
        const over = (this.opts.budgetLevel?.() ?? 'ok') === 'over';
        // 有专门的便宜模型就用它（带它自己的型号）；否则用角色自己的模型；mock 和预算用完时走规则摘要
        const own = r.adapter?.provider === 'mock' ? null : r.adapter;
        const useCheap = !!this.memoryAdapter;
        void compactMemory(a, over ? null : useCheap ? this.memoryAdapter : own, undefined, this.opts.onUsage, useCheap ? this.opts.memorySpec ?? null : null);
      }
    }
  }

  /**
   * 回合提示词的各栏（见 prompts/README.md）：此刻 / 眼前 / 心情 / 记得的事 / 别人跟你说过的 / 听到的 / 刚发生的 / 你此刻 / 可以说心里话的人 / 只有你知道的事 / trigger
   */
  private turnData(r: Runtime, obs: Observation, heard: string[], now: number): TurnData {
    const a = r.state;
    const diff = this.difficulty;
    const nearIds = [...obs.nearby_agents].sort((x, y) => x.distance - y.distance).map((n) => n.id);
    // 心情：在场的人 + 最近打过交道的人，最多 6 个
    const recent = Object.entries(a.relations)
      .filter(([id, rel]) => !nearIds.includes(id) && (rel.notes.length || rel.affection !== 0 || rel.trust !== 0))
      .map(([id]) => id);
    // 没来往过、又不在跟前的人就不列（省 token）；跟前 2 格内的人总要列
    const nearDist = new Map(obs.nearby_agents.map((n) => [n.id, n.distance]));
    const ids = [...nearIds, ...recent]
      .filter((id) => this.agent(id))
      .filter((id) => {
        const rel = a.relations[id];
        return (nearDist.get(id) ?? 99) <= 2 || (rel && (rel.trust !== 0 || rel.affection !== 0 || rel.notes.length));
      })
      .slice(0, 6);
    const feelings = ids
      .map((id) => {
        const rel = a.relations[id];
        return describeFeeling(this.nameOf(id), rel?.affection ?? 0, rel?.trust ?? 0, !!rel?.distrust);
      })
      .join('；');
    // 刚发生的事：上回合之后进记忆、又不是对话（对话在“刚才听到的”里）
    const isSpeech = (l: string) => /说[:：]|悄悄对|偷听到|给了我/.test(l);
    const events = a.memory.slice(r.memoryMark).filter((l) => !isSpeech(l)).slice(-6).map(stripStamp);
    // 别人跟你说过的：只放在场的人的原话，对口供用
    const claims = nearIds.flatMap((id) => (a.claims[id] ?? []).map((t) => `${this.nameOf(id)}曾对你说：「${t}」`)).slice(-8);
    // 可以说心里话的人：在场、信任够了难度门槛
    const confide = nearIds.filter((id) => (a.relations[id]?.trust ?? 0) >= diff.server.minor_secret_trust).map((id) => this.nameOf(id));
    const priv = this.releaseSecrets(r, obs, now);
    const extra: string[] = [];
    if (a.jailedUntil > now) extra.push(`你被关着，还要 ${Math.ceil((a.jailedUntil - now) / 1000)} 秒才放出来`);
    if (a.eavesdropping) extra.push(`你正在偷听${this.nameOf(a.eavesdropping)}`);
    const here = nearestLandmark(this.landmarks, a.pos);
    const closest = here ?? [...this.landmarks].sort((x, y) => cheb(x.pos, a.pos) - cheb(y.pos, a.pos))[0];
    return {
      time: `第${obs.day}天 ${PHASE_CN[obs.phase]} ${obs.time}`,
      place: here ? here.name : closest ? `${closest.name}外头的野地` : '野地里',
      scene: compactScene(obs, extra),
      feelings: feelings || undefined,
      memory: a.longMemory.join('') || undefined,
      heard,
      events,
      claims,
      state: this.stateText(a, now),
      confide,
      private: priv,
      trigger: r.wakeReason || undefined,
    };
  }

  /** 【你此刻】：气头上、被关着……更容易说漏嘴 */
  private stateText(a: AgentState, now: number): string | undefined {
    if (a.mood && a.mood.until > now) return a.mood.text;
    if (a.mood) a.mood = null;
    return undefined;
  }

  /**
   * 要紧的秘密由服务器保管：对身边某个人的信任过了难度门槛（精明难度还要独处、要紧关头）才释放进【只有你知道的事】。
   * 释放过的一直放着（很短），角色之后可以拿出来说。
   */
  private releaseSecrets(r: Runtime, obs: Observation, now: number): string[] {
    const a = r.state;
    const diff = this.difficulty;
    for (const m of r.card?.server_only?.major_secrets ?? []) {
      if (!m.text || a.released.includes(m.text)) continue;
      const confidant = obs.nearby_agents.find((n) => n.distance <= 3 && (a.relations[n.id]?.trust ?? 0) >= diff.server.major_secret_trust);
      if (!confidant) continue;
      if (diff.server.major_needs_private && obs.nearby_agents.some((n) => n.id !== confidant.id && n.distance <= 6)) continue;
      if (diff.server.major_needs_crisis && !(a.mood && a.mood.until > now)) continue;
      a.released.push(m.text);
      remember(a, `[第${obs.day}天 ${obs.time}] 我对${confidant.name}动了把心里那件事说出来的念头：${m.text}`);
      this.emit({ kind: 'notice', t: now, agentId: a.config.id, text: `（心事浮上来）${m.text}` });
      a.wake = false; // notice 会把它叫醒，但它此刻正在想，不必再想一遍
    }
    return a.released.slice(-3);
  }

  /** 模型输出的 feel：{"<id>":"+原因"} → 好感加减（核心 ±8、配角 ±6，同一人一回合只算一次），原因进对那个人的记忆 */
  private applyFeel(a: AgentState, feel?: Record<string, string>) {
    if (!feel) return;
    const seen = new Set<string>();
    for (const [ref, v] of Object.entries(feel)) {
      const other = this.agent(ref) ?? this.agents.find((o) => o.config.name === ref);
      if (!other || other === a || seen.has(other.config.id)) continue;
      seen.add(other.config.id);
      const sign = /^\s*[+＋]/.test(v) ? 1 : -1;
      const reason = v.replace(/^\s*[+\-＋－]\s*/, '').slice(0, 30);
      adjustAffection(a, other.config.id, sign * (a.config.tier === 'core' ? 8 : 6), reason || undefined);
      if (sign < 0 && /骗|谎|哄|瞒|诓/.test(reason)) noteExposure(a, other.config.id);
    }
  }

  /** 让某人“听到”一句话（进他的刚才听到的，并叫醒他） */
  hear(agentId: string, line: string, reason?: string) {
    const r = this.runtimes.find((x) => x.state.config.id === agentId);
    if (!r || !r.state.alive) return;
    r.heard.push(line);
    r.state.wake = true;
    if (reason) r.wakeReason ||= reason;
  }

  /** 广播事件，并把它写进能“感知”到的角色记忆里 */
  emit(ev: WorldEvent) {
    this.events.push(ev);
    if (this.events.length > EVENT_LOG_LIMIT) this.events.shift();
    this.perceive(ev);
    // 玩家不“思考”，他的 heard 没人消费、记忆没人压缩：别让它们无限长
    for (const r of this.runtimes) {
      if (r.state.kind !== 'player') continue;
      r.heard.length = 0;
      if (r.state.memory.length > 60) r.state.memory.splice(0, r.state.memory.length - 60);
    }
    for (const fn of this.eventListeners) fn(ev);
  }

  /** 哪些人感知到这件事、各自看到什么 */
  private perceive(ev: WorldEvent) {
    const time = this.clock.time;
    const nameOf = (id: string) => this.nameOf(id);
    const stamp = (s: string) => `[第${this.clock.day}天 ${time}] ${s}`;
    const near = (a: AgentState, p: Vec3, radius: number) => cheb(a.pos, p) <= radius && Math.abs(a.pos.y - p.y) <= 4;
    switch (ev.kind) {
      case 'thought':
      case 'error':
      case 'chapter':
      case 'ending':
        return;
      case 'system':
        return;
      case 'game':
        // 开场白、“说书人正在写结局”这类是写给玩家看的（提到玩家、分钟数），不能进 AI 的记忆
        for (const r of this.runtimes) if (ev.audience !== 'player' || r.state.kind === 'player') remember(r.state, stamp(ev.text));
        return;
      case 'story': {
        for (const r of this.runtimes) {
          const a = r.state;
          const involved = ev.participants?.includes(a.config.id);
          remember(a, stamp(`【发生了一件事】${ev.text}${involved ? '（你牵涉其中）' : ''}`));
          if (involved) {
            a.wake = true;
            r.wakeReason = `发生了一件事：${ev.title}`;
          }
        }
        return;
      }
    }
    // 下面都是带 agentId 的事件
    const actor = this.agent(ev.agentId);
    if (!actor) return;
    const name = actor.config.name;
    const line = describe(ev, name, nameOf, this.landmarks);
    for (const r of this.runtimes) {
      const a = r.state;
      const self = a === actor;
      if (!a.alive) continue;
      switch (ev.kind) {
        case 'fail':
          if (self) {
            a.lastResult = `没做成：${ev.text}`;
            remember(a, stamp(`我没做成: ${ev.text}`));
          }
          break;
        case 'notice':
          if (self) {
            remember(a, stamp(ev.text));
            a.wake = true;
            r.wakeReason ||= sanitizeText(ev.text, 40);
          }
          break;
        case 'sneak':
          if (self) {
            a.lastResult = `得手了：${ev.text}`;
            remember(a, stamp(`我${ev.text}，没人发现`));
          }
          break;
        case 'whisper': {
          const isTo = ev.to === a.config.id;
          const overheard = ev.overheardBy?.includes(a.config.id);
          const relayName = ev.relayTo ? nameOf(ev.relayTo) : null;
          if (self) {
            a.lastResult = relayName ? `托${nameOf(ev.to)}给${relayName}带话` : `对${nameOf(ev.to)}说了悄悄话`;
            remember(a, stamp(relayName ? `我托${nameOf(ev.to)}给${relayName}带话: ${ev.text}` : `我悄悄对${nameOf(ev.to)}说: ${ev.text}`));
          } else if (isTo) {
            const said = sanitizeText(ev.text);
            // 托带的话：听到的是“谁托你告诉谁”，带不带、怎么带由他自己决定（原话记在事件里，他之后说出去的是另一条事件）
            remember(a, stamp(relayName ? `${name}托我告诉${relayName}: ${said}` : `${name}悄悄对我说: ${said}`));
            r.heard.push(relayName ? `${name}托你告诉${relayName}：「${said}」` : `${name}悄悄对你说：「${said}」`);
            addClaim(a, actor.config.id, said);
            a.wake = true;
            r.wakeReason = relayName ? `${name}托你给${relayName}带话` : `${name}走到你跟前，悄悄跟你说了话`;
          } else if (overheard) {
            const said = sanitizeText(ev.text);
            remember(a, stamp(`我偷听到${name}悄悄对${nameOf(ev.to)}说: ${said}`));
            r.heard.push(`你偷听到${name}低声对${nameOf(ev.to)}说：「${said}」`);
            a.wake = true;
            r.wakeReason ||= `你偷听到了${name}的悄悄话`;
          } else if (near(a, actor.pos, WHISPER_LEAK_RADIUS)) {
            // 旁边的人看见你们在说悄悄话，有三成机会听去几个字
            const leak = this.rnd() < 0.3 ? `，好像提到“${sanitizeText(ev.text).slice(0, 6)}…”` : '';
            const text = `${name}在对${nameOf(ev.to)}说悄悄话${leak}`;
            remember(a, stamp(`我看见${text}`));
            if (a.kind === 'player') this.emit({ kind: 'notice', t: ev.t, agentId: a.config.id, text: `你看见${text}` });
          }
          break;
        }
        case 'wechat': {
          if (self) {
            a.lastResult = `给${nameOf(ev.to)}发了微信`;
            remember(a, stamp(`我给${nameOf(ev.to)}发微信: ${sanitizeText(ev.text)}`));
          } else if (ev.to === a.config.id) {
            const said = sanitizeText(ev.text);
            remember(a, stamp(`${name}发微信给我: ${said}`));
            r.heard.push(`${name}发来微信：「${said}」`);
            addClaim(a, actor.config.id, said);
            a.wake = true;
            r.wakeReason = `${name}给你发了微信`;
          }
          break;
        }
        case 'letter': {
          if (self) {
            const mine = ev.to === a.config.id;
            const from = nameOf(ev.from);
            const toName = nameOf(ev.to);
            const body = sanitizeText(ev.text, 200);
            const viaText = ev.via === 'chest' ? '是从箱子里取的' : ev.via ? `是${nameOf(ev.via)}捎来的` : '';
            remember(a, stamp(mine ? `我收到${from}写给我的信${viaText ? `（${viaText}）` : ''}: ${body}` : `我拆开了${from}写给${toName}的信: ${body}`));
            r.heard.push(mine ? `你收到一封信，落款是${from}${viaText ? `，${viaText}` : ''}：「${body}」` : `你拆开了${from}写给${toName}的信：「${body}」`);
            if (mine) addClaim(a, ev.from, body);
            a.lastResult = mine ? `收到了${from}的信` : `拆开了${from}写给${toName}的信`;
            a.wake = true;
            r.wakeReason = mine ? `你收到了${from}的信` : '你拆开了一封信';
          }
          break;
        }
        case 'caught': {
          if (self) {
            a.lastResult = `被当场抓住了！${ev.penalty}`;
            remember(a, stamp(`我${ev.what === 'steal' ? '偷' : '偷听'}${nameOf(ev.target)}被${nameOf(ev.by)}当场抓住，${ev.penalty}`));
          } else if (near(a, actor.pos, HEARING_RADIUS)) {
            remember(a, stamp(line));
            a.wake = true;
            r.wakeReason = line;
          }
          if (self) a.mood = { text: '你刚被人当场抓住，又羞又气', until: ev.t + 180_000 };
          break;
        }
        case 'say': {
          if (self) {
            a.lastResult = `说了: ${ev.text.slice(0, 30)}`;
            remember(a, stamp(`我${line}`));
          } else if (near(a, actor.pos, HEARING_RADIUS)) {
            remember(a, stamp(line));
            // 带上“对谁说”，被点名的人才知道自己被点名，旁人也知道这话不是冲自己说的
            const said = sanitizeText(ev.text);
            const toWhom = ev.to === a.config.id ? '对你' : ev.to ? `对${nameOf(ev.to)}` : '';
            r.heard.push(`${name}${toWhom}说：「${said}」`);
            if (ev.to === a.config.id) addClaim(a, actor.config.id, said);
            if (ev.to === a.config.id || (!ev.to && cheb(a.pos, actor.pos) <= 3)) {
              a.wake = true;
              r.wakeReason = ev.to === a.config.id ? `${name}对你说了话` : `${name}在你旁边说话`;
            }
          }
          break;
        }
        case 'give':
          if (self) {
            a.lastResult = `把${itemName(ev.item)}给了${nameOf(ev.to)}`;
            remember(a, stamp(`我${line}`));
          } else if (ev.to === a.config.id) {
            remember(a, stamp(`${name}给了我${itemName(ev.item)}×${ev.count}`));
            r.heard.push(`${name}给了你${itemName(ev.item)}×${ev.count}`);
            a.wake = true;
            r.wakeReason = `${name}给了你东西`;
          } else if (near(a, actor.pos, HEARING_RADIUS)) remember(a, stamp(line));
          break;
        default:
          // emote / move / arrive / block / chest：附近的人看见
          if (self) {
            if (ev.kind === 'arrive') a.lastResult = `到了${ev.target}`;
            else if (ev.kind === 'block') a.lastResult = `${ev.op === 'break' ? '挖掉了' : '放了'}一块${blockById(BLOCK[ev.block] ?? 0).cn}`;
            else if (ev.kind === 'chest') a.lastResult = `${ev.op === 'put' ? '放进箱子' : '从箱子拿了'}${itemName(ev.item)}×${ev.count}`;
            if (ev.kind !== 'move') remember(a, stamp(`我${line}`));
          } else if (near(a, actor.pos, HEARING_RADIUS)) {
            remember(a, stamp(line));
            if (ev.kind === 'arrive' && cheb(a.pos, actor.pos) <= 2) {
              a.wake = true;
              r.wakeReason ||= `${name}走到了你跟前`;
            }
          }
      }
    }
  }

  /** 傍晚时把柄在 AI 之间传一传 */
  spreadRumors() {
    const spread = spreadRumors(this.agents.filter((a) => a.kind === 'ai'), this.clock.time, this.rnd);
    for (const s of spread) this.emit({ kind: 'notice', t: Date.now(), agentId: s.to.config.id, text: s.line });
    return spread.length;
  }

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.emit({ kind: 'system', t: Date.now(), text: p ? '时间暂停了。' : '时间继续流动。' });
  }

  /** 推给前端的精简状态 */
  snapshot() {
    const now = Date.now();
    return {
      time: this.clock.time,
      day: this.clock.day,
      phase: this.clock.phase,
      paused: this.paused,
      agents: this.runtimes.map(({ state: a }) => ({
        id: a.config.id,
        name: a.config.name,
        kind: a.kind,
        tier: a.config.tier ?? 'extra',
        public: a.config.role?.public ?? a.config.personality,
        provider: a.config.provider,
        providerLabel: a.providerLabel,
        model: a.config.model ?? '',
        color: a.config.color,
        alive: a.alive,
        pos: a.pos,
        facing: a.facing,
        moving: a.path.length > 0,
        thinking: a.thinking,
        emote: a.emote,
        jailed: a.jailedUntil > now ? Math.ceil((a.jailedUntil - now) / 1000) : 0,
        eavesdropping: a.eavesdropping && a.eavesdropUntil > now ? a.eavesdropping : null,
        location: nearestLandmark(this.landmarks, a.pos)?.name ?? null,
        lastThought: a.lastThought,
        goal: a.goal,
        wish: a.wish,
        inventory: a.inventory,
        trust: Object.fromEntries(Object.entries(a.relations).map(([id, r]) => [id, r.trust])),
        stats: a.stats,
      })),
    };
  }

  // —— 存档 ——
  exportState() {
    return {
      elapsedMs: this.elapsedMs,
      world: this.world.toBase64(),
      chests: [...this.chests.entries()],
      agents: this.runtimes.map(({ state: a }) => ({
        id: a.config.id,
        alive: a.alive,
        pos: a.pos,
        facing: a.facing,
        inventory: a.inventory,
        memory: a.memory,
        longMemory: a.longMemory,
        relations: a.relations,
        wish: a.wish,
        goal: a.goal,
        lastResult: a.lastResult,
        stats: a.stats,
        jailedMs: a.jailedUntil ? Math.max(0, a.jailedUntil - Date.now()) : 0,
        claims: a.claims,
        released: a.released,
      })),
      letters: [...this.letters.entries()],
    };
  }

  importState(s: ReturnType<Simulation['exportState']>) {
    this.elapsedMs = s.elapsedMs ?? 0;
    if (typeof s.world === 'string') {
      const buf = Buffer.from(s.world, 'base64');
      if (buf.length === this.world.data.length) this.world.data.set(buf);
    }
    this.chests.clear();
    for (const [k, v] of s.chests ?? []) this.chests.set(k, v);
    this.letters.clear();
    for (const [k, v] of s.letters ?? []) this.letters.set(k, v);
    for (const sa of s.agents ?? []) {
      const a = this.agent(sa.id);
      if (!a) continue;
      a.alive = sa.alive ?? true;
      a.pos = sa.pos ?? a.pos;
      a.facing = sa.facing ?? a.facing;
      a.inventory = sa.inventory ?? a.inventory;
      a.memory = sa.memory ?? [];
      a.longMemory = sa.longMemory ?? [];
      a.relations = sa.relations ?? {};
      a.wish = sa.wish ?? a.wish;
      a.goal = sa.goal ?? '';
      a.lastResult = sa.lastResult ?? '';
      a.stats = sa.stats ?? a.stats;
      a.claims = sa.claims ?? {};
      a.released = sa.released ?? [];
      a.mood = null;
      for (const rel of Object.values(a.relations)) if (typeof rel.affection !== 'number') rel.affection = rel.trust; // 旧存档没有好感值
      a.jailedUntil = sa.jailedMs ? Date.now() + sa.jailedMs : 0;
      a.path = [];
      a.wake = true;
    }
  }
}

/** 某个事件某个观众能不能看到（玩家视角要遮住别人的私聊、偷东西和内心想法；观察模式全看） */
export function visibleTo(ev: WorldEvent, viewerId: string | null): boolean {
  if (viewerId === null) return true;
  switch (ev.kind) {
    case 'thought':
    case 'error':
      return false;
    case 'whisper':
      return ev.agentId === viewerId || ev.to === viewerId || !!ev.overheardBy?.includes(viewerId);
    case 'wechat':
      return ev.agentId === viewerId || ev.to === viewerId;
    case 'sneak':
    case 'fail':
    case 'notice':
    case 'letter':
      return ev.agentId === viewerId;
    default:
      return true;
  }
}

function describe(ev: Extract<WorldEvent, { agentId: string }>, name: string, nameOf: (id: string) => string, _landmarks: Landmark[]): string {
  switch (ev.kind) {
    case 'say':
      // 进记忆的话也过一遍清洗（玩家可能打出括号、JSON 之类伪造格式的东西）
      return `${name}${ev.to ? ` 对${nameOf(ev.to)}` : ''} 说: ${sanitizeText(ev.text)}`;
    case 'whisper':
      return `${name} 悄悄对${nameOf(ev.to)}说了些什么`;
    case 'wechat':
      return `${name} 给${nameOf(ev.to)}发了条微信`;
    case 'letter':
      return `${name} 读了一封${nameOf(ev.from)}写给${nameOf(ev.to)}的信`;
    case 'emote':
      return `${name} 做了个动作: ${ev.emote}`;
    case 'move':
      return `${name} 动身前往${ev.target}`;
    case 'arrive':
      return `${name} 到达了${ev.target}`;
    case 'block':
      return `${name} 在 (${ev.pos.x},${ev.pos.y},${ev.pos.z}) ${ev.op === 'break' ? '挖掉了' : '放了'}一块${blockById(BLOCK[ev.block] ?? 0).cn}`;
    case 'give':
      return `${name} 给了${nameOf(ev.to)}${itemName(ev.item)}×${ev.count}`;
    case 'chest':
      return `${name} ${ev.op === 'put' ? '往箱子里放了' : '从箱子里拿了'}${itemName(ev.item)}×${ev.count}`;
    case 'sneak':
      return `${name} ${ev.text ?? ''}`;
    case 'caught':
      return `${name} ${ev.what === 'steal' ? '偷' : '偷听'}${nameOf(ev.target)}被${nameOf(ev.by)}当场抓住，${ev.penalty}`;
    case 'fail':
      return `${name} 没做成: ${ev.text}`;
    case 'notice':
      return ev.text;
    case 'thought':
      return ev.text;
    case 'error':
      return ev.text;
  }
}
