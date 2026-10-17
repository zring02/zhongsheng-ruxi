import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAdapter } from './adapters/index.js';
import { CallLog, recordingAdapter } from './calllog.js';
import { ROOT } from './config.js';
import { CostMeter, LEVEL_TEXT, type BudgetLevel, type CostState } from './cost.js';
import { itemName } from './actions.js';
import { assignModels, storytellerConfig, type ModelCatalog } from './models.js';
import { attachCards, difficultyDef, promptPack, worldFromScenario, sanitizeText } from './persona.js';
import { applyTheme, buildRoster, DEFAULT_CURRENCY, DEFAULT_PENALTIES, summarizeScenario, type Roster } from './scenario.js';
import { Simulation } from './simulation.js';
import { Storyteller, type EndingOut, type StoryContext } from './storyteller.js';
import type { GameOptions, GamePhase, ModelAdapter, ModelSpec, PersonaCard, Scenario, WorldEvent } from './types.js';

// 一局游戏：剧情模式（限时、分游戏日、有收网的大事）或沙盒（不限时、自动存档）。
// 管游戏时钟、说书人调度、章回、结局、存档/读档；世界本身交给 Simulation。

export const SAVE_DIR = process.env.SAVE_DIR ?? resolve(ROOT, 'saves');
const ENDINGS_FILE = () => resolve(SAVE_DIR, 'endings.json');
/** 说书人多久放一次事件（真实分钟），按活跃度；实际间隔再随机 ±40% */
const STORY_INTERVAL_MIN: Record<Scenario['storyteller']['activity'], number> = { quiet: 8, normal: 5.5, dramatic: 3.5 };
/** 一天四段各占多少：剧情模式平均每段 5 分钟；沙盒按真实昼夜的样子，夜里长一点 */
const PHASE_SPLIT: Record<GameOptions['mode'], readonly [number, number, number, number]> = { story: [0.25, 0.25, 0.25, 0.25], sandbox: [0.25, 0.25, 0.15, 0.35] };
const PHASES: readonly GamePhase[] = ['morning', 'noon', 'evening', 'night'];
/** 每段对应的钟点区间 */
const PHASE_HOURS: Record<GamePhase, [number, number]> = { morning: [6, 12], noon: [12, 17], evening: [17, 21], night: [21, 30] };
/** 玩家多久没人搭理，说书人就派一位核心人物过来 */
const LONELY_MS = 5 * 60_000;
const TIMELINE_LIMIT = 400;
/** 回放：每隔多久记一帧位置，最多记多少帧（2 秒一帧，3600 帧 = 2 小时） */
const REPLAY_FRAME_MS = 2000;
const REPLAY_FRAME_LIMIT = 3600;
/** 回放用的完整事件日志上限 */
const EVENT_LOG_LIMIT = 6000;
const FACINGS_ORDER = ['north', 'east', 'south', 'west'] as const;
const FACING_INDEX: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };
/** 表情在帧里存成下标 + 1（0 = 没有表情） */
const EMOTE_INDEX = ['wave', 'laugh', 'think', 'sad', 'dance', 'sleep', 'angry', 'love'];

/** 回放用的事件：多一个 e = 开局后毫秒（WorldEvent.t 是墙上时间，暂停、读档后对不上帧） */
export type ReplayEvent = WorldEvent & { e: number };

export interface ReplayFrame {
  /** 开局后的毫秒数（模拟时间） */
  t: number;
  /** 每个角色（按 replay().agents 的顺序）：[x, y, z, 朝向下标, 表情下标+1] */
  a: number[][];
}
const CAUSAL_LIMIT = 300;
const AUTOSAVE_MS = 60_000;

export interface Chapter {
  day: number;
  title: string;
  text: string;
}

export interface BlockLogEntry {
  t: number;
  day: number;
  agentId: string;
  op: 'break' | 'place';
  block: string;
  pos: { x: number; y: number; z: number };
}

export interface CausalEntry {
  t: number;
  day: number;
  agentId: string;
  name: string;
  thought: string;
  because?: string;
}

export interface SaveFile {
  id: string;
  savedAt: number;
  options: GameOptions;
  /** 本局实际生效的剧本（沙盒自定义已合并） */
  scenario: Scenario;
  status: 'running' | 'ended';
  chapters: Chapter[];
  ending: EndingOut | null;
  timeline: string[];
  causal: CausalEntry[];
  blockLog: BlockLogEntry[];
  /** 开局时的世界（结算做前后对比） */
  worldStart: string;
  /** 回放：每 2 秒一帧的位置 */
  frames?: ReplayFrame[];
  /** 回放：全部事件（含内心想法） */
  eventLog?: ReplayEvent[];
  cost?: CostState;
  recentTitles: string[];
  nextStoryAt: number;
  bigEventDone: boolean;
  trackDone: number[];
  revealed: number[];
  sim: ReturnType<Simulation['exportState']>;
}

export class GameSession {
  readonly id: string;
  readonly scenario: Scenario;
  readonly roster: Roster;
  readonly sim: Simulation;
  readonly storyteller: Storyteller;
  readonly startedAt = Date.now();
  status: 'running' | 'ended' = 'running';
  chapters: Chapter[] = [];
  ending: EndingOut | null = null;
  /** 给说书人看的事件日志（中文行） */
  timeline: string[] = [];
  /** 因果日志：谁因为什么这么想（结算串蝴蝶效应链用） */
  causal: CausalEntry[] = [];
  /** 谁在哪挖了/放了什么（结算时让玩家亲手改过的方块发光） */
  blockLog: BlockLogEntry[] = [];
  /** 开局时的世界快照（base64），结算做“世界的前后对比” */
  worldStart: string;
  /** 回放：每 REPLAY_FRAME_MS 一帧，每帧是所有角色的 [x, y, z, 朝向, 表情] */
  frames: ReplayFrame[] = [];
  /** 回放：全部事件（含内心想法、私聊），观察者视角，上限 EVENT_LOG_LIMIT */
  eventLog: ReplayEvent[] = [];
  /** 本局模型花费 */
  readonly meter: CostMeter;
  /** 每次模型调用的记录（CALL_LOG=1 或 CALL_LOG_DIR 时才有） */
  readonly callLog: CallLog | null;
  private lastFrameAt = -Infinity;
  private lastLevel: BudgetLevel = 'ok';
  private recentTitles: string[] = [];
  private nextStoryAt = 15_000;
  private bigEventDone = false;
  private trackDone = new Set<number>();
  private pendingHints: { hint: string; source: 'player' | 'track' | 'big'; requestedBy?: string }[] = [];
  private lastHintAt = -60_000;
  private storyBusy = false;
  private lastDay = 0;
  private lastPhase: GamePhase | null = null;
  private lastAutosave = 0;
  private endingPromise: Promise<void> | null = null;
  private playerOnline = false;
  private awaySince: number | null = null;
  private awayTimelineIndex = 0;
  readonly dayMs: number;
  private readonly split: readonly [number, number, number, number];
  /** 玩家上次跟人有来往（说话、私聊、送东西、收信、剧情事件）的时刻（开局后毫秒） */
  private lastContactAt = 0;
  /** 当前时段开始的时刻、这一时段说书人有没有放过事件（剧情文档：每段至少一个要玩家表态的场面） */
  private periodStartAt = 0;
  private storyThisPeriod = false;
  private unsubs: (() => void)[] = [];

  constructor(
    base: Scenario,
    readonly options: GameOptions,
    readonly catalog: ModelCatalog,
    id?: string,
  ) {
    this.id = id ?? `${options.scenarioId}-${Date.now().toString(36)}`;
    this.roster = buildRoster(base, options);
    this.scenario = this.roster.scenario;
    applyTheme(this.scenario.world.theme);
    const ais = assignModels(this.roster.ais, this.catalog);
    const player = this.roster.player ? { ...assignModels([this.roster.player], this.catalog)[0], provider: 'mock', model: undefined } : null;
    // 提示词包（“AI角色提示词”线程的模板和人设卡）：有就给每个 AI 挂卡，没有就用内置占位提示词
    const pack = promptPack();
    const worldFile = pack ? pack.world(this.scenario) : worldFromScenario(this.scenario);
    if (pack) attachCards(pack, this.scenario, ais, worldFile);
    const difficulty = difficultyDef(options.difficulty ?? 'normal');
    this.meter = new CostMeter(this.catalog);
    this.callLog = callLogFor(this.id);
    const cheap = this.cheapModel();
    const wrap = this.callLog ? (adapter: ModelAdapter) => recordingAdapter(adapter, this.callLog!) : (adapter: ModelAdapter) => adapter;
    const sb = options.sandbox ?? {};
    this.dayMs = options.mode === 'story' ? (this.scenario.duration.minutes * 60_000) / this.scenario.duration.days : ((24 * 60) / Math.max(0.1, sb.minutesPerSecond ?? 1)) * 1000;
    this.split = PHASE_SPLIT[options.mode];
    this.sim = new Simulation({
      seed: options.seed ?? this.scenario.world.seed ?? Number(process.env.WORLD_SEED ?? 42),
      size: this.scenario.world.size,
      landmarks: this.scenario.world.landmarks,
      ais,
      player,
      background: this.scenario.background,
      genre: this.scenario.genre,
      penalties: this.scenario.penalties ?? DEFAULT_PENALTIES,
      jailLandmark: this.scenario.world.jail ?? 'hill',
      maxTokens: { core: this.catalog.maxTokens.core, extra: this.catalog.maxTokens.extra },
      memoryAdapter: wrap1(cheap?.adapter ?? null, wrap),
      memorySpec: cheap?.spec ?? null,
      promptPack: pack,
      worldFile,
      difficulty,
      currency: this.scenario.currency ?? DEFAULT_CURRENCY,
      features: { wechat: !!this.scenario.features?.wechat },
      onUsage: (u) => this.meter.add(u),
      budgetLevel: () => this.meter.level,
      wrapAdapter: this.callLog ? (adapter) => wrap(adapter) : undefined,
    });
    const stCfg = storytellerConfig(this.catalog);
    const st = resolveAdapter(stCfg);
    if (st.fallback) console.warn(`[说书人] ${stCfg.provider} 未配置 key，改用内置随机事件`);
    this.storyteller = new Storyteller(stCfg, st.fallback ? null : wrap(st.adapter), this.scenario, this.catalog.maxTokens.storyteller);
    this.storyteller.onUsage = (u) => this.meter.add(u);
    this.unsubs.push(this.sim.onTick((e, now) => this.tick(e, now)));
    this.unsubs.push(this.sim.onEvent((ev) => this.record(ev)));
    this.sim.clock = this.clockAt(0);
    this.worldStart = this.sim.world.toBase64();
  }

  /** 记忆压缩用最便宜的可用模型：返回适配器和这个模型自己的型号参数（调用时要用它的型号，不能用角色的） */
  private cheapModel(): { adapter: ModelAdapter; spec: ModelSpec } | null {
    for (const key of [...this.catalog.tiers.extra, ...this.catalog.tiers.core]) {
      const spec = this.catalog.models[key];
      const r = resolveAdapter({ id: '_mem', name: '_mem', color: '', personality: '', ...spec });
      if (!r.fallback && spec.provider !== 'mock') return { adapter: r.adapter, spec };
    }
    return null;
  }

  get playerId() {
    return this.sim.player?.config.id ?? null;
  }

  get mode() {
    return this.options.mode;
  }

  start() {
    this.sim.emit({ kind: 'game', t: Date.now(), text: this.openingText(), day: 1, phase: 'morning', audience: 'player' });
    this.lastDay = 1;
    this.lastPhase = 'morning';
    // 开场卡关掉后 30 秒内要有第一个人上门：把“冷场”计时往前拨
    this.lastContactAt = 30_000 - LONELY_MS;
    this.periodStartAt = 0;
    this.storyThisPeriod = false;
    this.sim.start();
  }

  /**
   * 开场卡（剧情文档“开局”）：处境、身边的核心人物和自己对他们的看法、自己知道的小秘密、心愿。
   * 30 秒能读完；前端关掉卡就开演。玩家有人设卡（穿书）时从卡上取，没有就用剧本里的玩家模板。
   */
  opening() {
    const p = this.sim.player;
    if (!p) return null;
    const pack = promptPack();
    let card: PersonaCard | null = null;
    try {
      if (pack?.hasScenario(this.scenario.id) && pack.renderer.listCards(this.scenario.id).includes(p.config.id)) card = pack.renderer.loadCard(this.scenario.id, p.config.id);
    } catch {
      card = null;
    }
    const role = p.config.role;
    const relations = { ...(role?.relations ?? {}), ...(card?.relations ?? {}) };
    const people = this.sim.agents
      .filter((a) => a.kind === 'ai' && a.alive)
      .sort((a, b) => (a.config.tier === 'core' ? 0 : 1) - (b.config.tier === 'core' ? 0 : 1))
      .slice(0, 6)
      .map((a) => ({ id: a.config.id, name: a.config.name, public: a.config.role?.public ?? a.config.personality, relation: relations[a.config.id] ?? '' }));
    return {
      name: p.config.name,
      situation: [this.scenario.playerIntro, card?.identity ?? role?.public ?? ''].filter(Boolean).join('\n'),
      people,
      secrets: (card?.secrets ?? []).map((s) => s.text),
      knot: card?.knot ?? role?.knot ?? '',
      wish: role?.wish ?? card?.wish ?? '',
      minutes: this.mode === 'story' ? this.scenario.duration.minutes : null,
      days: this.mode === 'story' ? this.scenario.duration.days : null,
      currency: this.scenario.currency ?? DEFAULT_CURRENCY,
    };
  }

  private openingText() {
    const p = this.sim.player;
    const who = p ? `${p.config.name}${p.config.role?.public ? `（${p.config.role.public}）` : ''}` : '';
    return `${this.scenario.name}开场。${this.scenario.tagline}${who ? ` 玩家扮演${who}。` : ' 这局没有玩家，只看居民们自己过日子。'}${this.mode === 'story' ? `这局约 ${this.scenario.duration.minutes} 分钟，共 ${this.scenario.duration.days} 天。` : '沙盒模式，不限时。'}`;
  }

  // —— 时钟 ——
  clockAt(elapsedMs: number) {
    const dayIndex = Math.floor(elapsedMs / this.dayMs) + 1;
    const frac = (elapsedMs % this.dayMs) / this.dayMs;
    let acc = 0;
    let phase: GamePhase = 'night';
    let hour = 21;
    for (let i = 0; i < PHASES.length; i++) {
      const w = this.split[i];
      if (frac < acc + w || i === PHASES.length - 1) {
        phase = PHASES[i];
        const [h0, h1] = PHASE_HOURS[phase];
        hour = h0 + (Math.min(1, (frac - acc) / w)) * (h1 - h0);
        break;
      }
      acc += w;
    }
    const m = Math.floor((hour % 24) * 60);
    return { day: dayIndex, phase, time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
  }

  get minutesLeft(): number | null {
    if (this.mode !== 'story') return null;
    return Math.max(0, (this.scenario.duration.minutes * 60_000 - this.sim.elapsedMs) / 60_000);
  }

  private tick(elapsedMs: number, now: number) {
    // 回放帧
    if (elapsedMs - this.lastFrameAt >= REPLAY_FRAME_MS && this.frames.length < REPLAY_FRAME_LIMIT) {
      this.lastFrameAt = elapsedMs;
      this.frames.push({ t: Math.round(elapsedMs), a: this.sim.agents.map((x) => [x.pos.x, x.pos.y, x.pos.z, FACING_INDEX[x.facing] ?? 0, x.emote ? EMOTE_INDEX.indexOf(x.emote) + 1 : 0]) });
    }
    // 预算档位变了：告诉大家，并让说书人跟着停用真模型
    const level = this.meter.level;
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.storyteller.budgetExhausted = level === 'over';
      if (LEVEL_TEXT[level]) this.sim.emit({ kind: 'system', t: now, text: LEVEL_TEXT[level] });
    }
    if (this.status !== 'running') return;
    const c = this.clockAt(elapsedMs);
    this.sim.clock = c;
    if (this.mode === 'story' && c.day > this.scenario.duration.days) {
      this.sim.clock = { ...c, day: this.scenario.duration.days, phase: 'night' };
      void this.end('时间到了');
      return;
    }
    if (c.day !== this.lastDay) {
      const finished = this.lastDay;
      this.lastDay = c.day;
      this.lastPhase = 'morning';
      this.periodStartAt = elapsedMs;
      this.storyThisPeriod = false;
      this.sim.emit({ kind: 'game', t: now, text: `第 ${c.day} 天天亮了。`, day: c.day, phase: 'morning' });
      void this.writeChapter(finished);
    } else if (c.phase !== this.lastPhase) {
      this.lastPhase = c.phase;
      this.periodStartAt = elapsedMs;
      this.storyThisPeriod = false;
      if (c.phase === 'noon') this.sim.emit({ kind: 'game', t: now, text: '日头到了正中，各家吃过午饭，人都出来走动了。', day: c.day, phase: 'noon' });
      else if (c.phase === 'evening') {
        this.sim.emit({ kind: 'game', t: now, text: '傍晚了，各家点起了灯。', day: c.day, phase: 'evening' });
        const n = this.sim.spreadRumors();
        if (n) this.timeline.push(`[第${c.day}天 傍晚] 有 ${n} 条闲话在人们之间传开`);
      } else if (c.phase === 'night') this.sim.emit({ kind: 'game', t: now, text: '入夜了，街上安静下来，大多数人歇下了。', day: c.day, phase: 'night' });
    }
    this.scheduleStory(elapsedMs, c);
    this.visitLonelyPlayer(elapsedMs);
    if (elapsedMs - this.lastAutosave >= AUTOSAVE_MS) {
      this.lastAutosave = elapsedMs;
      this.save();
    }
  }

  // —— 说书人 ——
  private scheduleStory(elapsedMs: number, c: { day: number }) {
    if (this.storyBusy) return;
    // 1. 玩家中途加的剧情，立刻安排
    const req = this.pendingHints.shift();
    if (req) return void this.runStory(req.hint, req.source, req.requestedBy);
    // 2. 固定骨架 / 原著轨道：到了那一天就放
    const st = this.scenario.storyteller;
    const trackIdx = (st.track ?? []).findIndex((t, i) => t.day <= c.day && !this.trackDone.has(i));
    if (trackIdx >= 0 && elapsedMs >= this.nextStoryAt - 60_000) {
      this.trackDone.add(trackIdx);
      const t = st.track![trackIdx];
      return void this.runStory(`${t.name ? `【${t.name}】` : ''}${t.hint}`, 'track');
    }
    // 3. 收网的大事
    if (st.bigEvent && !this.bigEventDone && this.mode === 'story') {
      const byMin = st.bigEvent.afterMinutes !== undefined && elapsedMs >= st.bigEvent.afterMinutes * 60_000;
      const byDay = st.bigEvent.afterDay !== undefined && c.day >= st.bigEvent.afterDay;
      const lastDay = c.day >= this.scenario.duration.days && this.sim.clock.phase !== 'morning';
      if (byMin || byDay || lastDay) {
        this.bigEventDone = true;
        return void this.runStory(st.bigEvent.hint, 'big');
      }
    }
    // 4. 每个时段至少一个场面：这一段过了六成还没放过事件，就放一个
    if (this.mode === 'story' && !this.storyThisPeriod) {
      const periodMs = this.dayMs * this.split[Math.max(0, PHASES.indexOf(this.sim.clock.phase))];
      if (elapsedMs - this.periodStartAt >= periodMs * 0.6) return void this.runStory();
    }
    // 5. 平时按活跃度随机抽
    if (elapsedMs >= this.nextStoryAt) void this.runStory();
  }

  /** 玩家 5 分钟没跟任何人有来往：说书人悄悄派一位核心人物过来找他（剧情文档：别让玩家闲着） */
  private visitLonelyPlayer(elapsedMs: number) {
    const p = this.sim.player;
    if (!p || this.mode !== 'story' || !this.playerOnline || elapsedMs - this.lastContactAt < LONELY_MS) return;
    this.lastContactAt = elapsedMs;
    const cands = this.sim.agents.filter((a) => a.kind === 'ai' && a.alive && !a.jailedUntil && a.config.tier === 'core' && !a.thinking);
    const pool = cands.length ? cands : this.sim.agents.filter((a) => a.kind === 'ai' && a.alive && !a.jailedUntil);
    if (!pool.length) return;
    const who = pool[Math.floor(this.sim.rnd() * pool.length)];
    this.sim.emit({ kind: 'notice', t: Date.now(), agentId: who.config.id, text: `你忽然想起有话要跟${p.config.name}说，去找他。` });
    this.sim.enqueue(who.config.id, { type: 'approach', target: p.config.id }, true);
    this.timeline.push(`[第${this.sim.clock.day}天 ${this.sim.clock.time}] ${p.config.name}半天没人搭理，${who.config.name}找了过来`);
  }

  private bumpNextStory() {
    const base = STORY_INTERVAL_MIN[this.scenario.storyteller.activity] * 60_000;
    this.nextStoryAt = this.sim.elapsedMs + base * (0.6 + this.sim.rnd() * 0.8);
  }

  private storyContext(): StoryContext {
    return {
      mode: this.mode,
      day: this.sim.clock.day,
      phase: this.sim.clock.phase,
      minutesLeft: this.minutesLeft,
      agents: this.sim.agents,
      player: this.sim.player,
      timeline: this.timeline,
      chapters: this.chapters,
      recentTitles: this.recentTitles,
      causal: this.causal,
    };
  }

  private async runStory(hint?: string, source?: 'player' | 'track' | 'big', requestedBy?: string) {
    this.storyBusy = true;
    this.storyThisPeriod = true;
    this.bumpNextStory();
    try {
      const ev = await this.storyteller.event(this.storyContext(), hint, source);
      if (this.status !== 'running') return;
      const now = Date.now();
      this.recentTitles.push(ev.title);
      if (this.recentTitles.length > 5) this.recentTitles.shift();
      this.sim.emit({ kind: 'story', t: now, title: ev.title, text: ev.text, participants: ev.participants, requestedBy });
      for (const [id, text] of Object.entries(ev.private ?? {})) this.sim.emit({ kind: 'notice', t: now, agentId: id, text: `（只有你知道）${text}` });
      for (const r of ev.reveal ?? []) this.sim.emit({ kind: 'notice', t: now, agentId: r.to, text: `（往事浮现）${r.text}` });
    } catch (err) {
      console.warn('[说书人] 投放事件失败:', (err as Error).message);
    } finally {
      this.storyBusy = false;
    }
  }

  /** 玩家对说书人说：“让镇上来一条龙” */
  requestStory(text: string, requestedBy?: string): 'ok' | 'empty' | 'busy' {
    const t = sanitizeText(text, 120);
    if (!t) return 'empty';
    // 每条都会让说书人立刻多调一次模型：限量、限频，免得刷花费
    if (this.pendingHints.length >= 2 || this.sim.elapsedMs - this.lastHintAt < 60_000) return 'busy';
    this.lastHintAt = this.sim.elapsedMs;
    this.pendingHints.push({ hint: t, source: 'player', requestedBy });
    return 'ok';
  }

  private async writeChapter(day: number) {
    if (day < 1 || this.chapters.some((c) => c.day === day)) return;
    try {
      // 章回是公开念给所有人听的：私下的话、没被发现的事、心里话不写进去（结局和结算才揭晓）
      const ch = await this.storyteller.chapter({ ...this.storyContext(), timeline: this.timeline.filter((l) => !l.includes('〔私〕')) }, day);
      if (this.chapters.some((c) => c.day === day)) return;
      this.chapters.push({ day, ...ch });
      this.chapters.sort((a, b) => a.day - b.day);
      this.sim.emit({ kind: 'chapter', t: Date.now(), day, title: ch.title, text: ch.text });
    } catch (err) {
      console.warn('[说书人] 写章回失败:', (err as Error).message);
    }
  }

  /** 结束：冻结世界，写最后一回和结局，记进结局图鉴 */
  end(reason = '故事到此为止'): Promise<void> {
    if (this.endingPromise) return this.endingPromise;
    this.status = 'ended';
    this.sim.frozen = true;
    this.endingPromise = (async () => {
      this.sim.emit({ kind: 'game', t: Date.now(), text: `${reason}，故事到此为止。说书人正在写结局……`, day: this.sim.clock.day, phase: this.sim.clock.phase, audience: 'player' });
      try {
        await this.writeChapter(this.sim.clock.day);
        this.ending = await this.storyteller.ending(this.storyContext());
      } catch (err) {
        console.warn('[说书人] 写结局失败:', (err as Error).message);
        this.ending = { title: '未完的故事', text: '说书人今天没有讲完。', epilogues: [], chain: [], reveals: [] };
      }
      this.sim.emit({ kind: 'ending', t: Date.now(), title: this.ending.title, text: this.ending.text, epilogues: this.ending.epilogues, chain: this.ending.chain, reveals: this.ending.reveals });
      this.recordEnding();
      this.save();
      this.sim.stop();
    })();
    return this.endingPromise;
  }

  dispose() {
    this.sim.stop();
    this.sim.frozen = true;
    for (const u of this.unsubs) u();
  }

  // —— 玩家在不在 ——
  setPlayerOnline(online: boolean) {
    if (!this.playerId || online === this.playerOnline) return;
    this.playerOnline = online;
    const runWhileAway = this.mode === 'sandbox' && !!this.options.sandbox?.runWhileAway;
    if (!online) {
      this.awaySince = Date.now();
      this.awayTimelineIndex = this.timeline.length;
      // 玩家一走先存一份；默认世界暂停（暂停时不会再自动存档）
      this.save();
      if (!runWhileAway && this.status === 'running') this.sim.setPaused(true);
    } else {
      if (!runWhileAway) {
        if (this.status === 'running') this.sim.setPaused(false);
      } else if (this.awaySince && Date.now() - this.awaySince > 60_000) {
        const since = this.timeline.slice(this.awayTimelineIndex);
        void this.storyteller.recap(this.storyContext(), since).then((r) => {
          this.sim.emit({ kind: 'chapter', t: Date.now(), day: this.sim.clock.day, title: r.title, text: r.text });
        });
      }
      this.awaySince = null;
    }
  }

  /** 这件事算不算“有人跟玩家有来往” */
  private touchesPlayer(ev: WorldEvent): boolean {
    const pid = this.playerId;
    if (!pid) return false;
    switch (ev.kind) {
      case 'say':
        return ev.agentId === pid || ev.to === pid;
      case 'whisper':
      case 'wechat':
      case 'give':
        return ev.agentId === pid || ev.to === pid;
      case 'letter':
        return ev.agentId === pid;
      case 'arrive':
        return ev.agentId !== pid && ev.target === `${this.sim.player?.config.name}跟前`;
      case 'caught':
        return ev.agentId === pid || ev.by === pid || ev.target === pid;
      case 'story':
        return !!ev.participants?.includes(pid);
      default:
        return false;
    }
  }

  // —— 日志 ——
  private record(ev: WorldEvent) {
    if (this.eventLog.length >= EVENT_LOG_LIMIT) this.eventLog.shift();
    this.eventLog.push({ ...ev, e: Math.round(this.sim.elapsedMs) });
    if (this.touchesPlayer(ev)) this.lastContactAt = this.sim.elapsedMs;
    const name = (id: string) => this.sim.nameOf(id);
    const c = this.sim.clock;
    const stamp = `[第${c.day}天 ${c.time}]`;
    let line: string | null = null;
    switch (ev.kind) {
      case 'say':
        line = `${name(ev.agentId)}${ev.to ? `对${name(ev.to)}` : ''}说：${ev.text}`;
        break;
      case 'whisper':
        line = `〔私〕${ev.relayTo ? `${name(ev.agentId)}托${name(ev.to)}给${name(ev.relayTo)}带话` : `${name(ev.agentId)}悄悄对${name(ev.to)}说`}：${ev.text}${ev.overheardBy?.length ? `（被${ev.overheardBy.map(name).join('、')}偷听到）` : ''}`;
        break;
      case 'wechat':
        line = `〔私〕${name(ev.agentId)}给${name(ev.to)}发微信：${ev.text}`;
        break;
      case 'letter':
        line = `〔私〕${name(ev.agentId)}${ev.to === ev.agentId ? `收到了${name(ev.from)}的信` : `拆开了${name(ev.from)}写给${name(ev.to)}的信`}：${ev.text}`;
        break;
      case 'give':
        line = `${name(ev.agentId)}把${itemName(ev.item)}×${ev.count}给了${name(ev.to)}`;
        break;
      case 'sneak':
        line = `〔私〕${name(ev.agentId)}${ev.text ?? ''}（没被发现）`;
        break;
      case 'caught':
        line = `${name(ev.agentId)}${ev.what === 'steal' ? '偷' : '偷听'}${name(ev.target)}被${name(ev.by)}当场抓住，${ev.penalty}`;
        break;
      case 'story':
        line = `【事件·${ev.title}】${ev.text}`;
        break;
      case 'game':
        line = ev.text;
        break;
      case 'block':
        line = `${name(ev.agentId)}在 (${ev.pos.x},${ev.pos.y},${ev.pos.z}) ${ev.op === 'break' ? '挖了' : '盖了'}一块`;
        if (this.blockLog.length >= 4000) this.blockLog.shift();
        this.blockLog.push({ t: ev.t, day: c.day, agentId: ev.agentId, op: ev.op, block: ev.block, pos: ev.pos });
        break;
      case 'arrive':
        line = ev.target ? `${name(ev.agentId)}到了${ev.target}` : null;
        break;
      case 'thought':
        if (this.causal.length >= CAUSAL_LIMIT) this.causal.shift();
        this.causal.push({ t: ev.t, day: c.day, agentId: ev.agentId, name: name(ev.agentId), thought: ev.text, because: ev.because });
        if (ev.because) line = `〔私〕${name(ev.agentId)}心想（因为${ev.because}）：${ev.text}`;
        break;
    }
    if (!line) return;
    this.timeline.push(`${stamp} ${line}`);
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.shift();
  }

  // —— 给前端的摘要 ——
  summary() {
    const stCfg = this.storyteller.config;
    return {
      id: this.id,
      status: this.status,
      mode: this.mode,
      scenario: summarizeScenario(this.scenario),
      day: this.sim.clock.day,
      phase: this.sim.clock.phase,
      time: this.sim.clock.time,
      totalDays: this.mode === 'story' ? this.scenario.duration.days : null,
      difficulty: this.options.difficulty ?? 'normal',
      /** 角色是不是用了提示词线程的人设卡（false = 内置占位提示词） */
      personaCards: this.sim.runtimes.filter((r) => r.state.kind === 'ai').map((r) => ({ id: r.state.config.id, card: r.card ? (r.card.generated ? 'generated' : 'full') : 'none' })),
      minutesLeft: this.minutesLeft,
      playerId: this.playerId,
      chapters: this.chapters,
      ending: this.ending,
      storyteller: this.storyteller.usingModel ? `${stCfg.provider}${stCfg.model ? ' · ' + stCfg.model : ''}` : '内置事件（未配置说书人模型）',
      sandbox: this.options.sandbox ?? null,
      cost: this.meter.summary(),
      opening: this.opening(),
      currency: this.scenario.currency ?? DEFAULT_CURRENCY,
      features: { wechat: !!this.scenario.features?.wechat },
    };
  }

  /** 回放素材：开局世界 + 每 2 秒的位置帧 + 全部事件（方块改动也在事件里），前端按时间轴重演 */
  replay() {
    return {
      id: this.id,
      status: this.status,
      scenario: { id: this.scenario.id, name: this.scenario.name, genre: this.scenario.genre },
      mode: this.mode,
      playerId: this.playerId,
      world: { size: this.sim.world.size, start: this.worldStart },
      landmarks: this.sim.landmarks,
      agents: this.sim.agents.map((a) => ({ id: a.config.id, name: a.config.name, color: a.config.color, kind: a.kind, tier: a.config.tier ?? 'extra' })),
      frameIntervalMs: REPLAY_FRAME_MS,
      facings: FACINGS_ORDER,
      emotes: EMOTE_INDEX,
      frames: this.frames,
      events: this.eventLog,
      chapters: this.chapters,
      ending: this.ending,
    };
  }

  /**
   * 结算素材：给结算动画和分享用。玩家怎么改变了这个世界——
   * 世界前后对比、玩家亲手改过的方块、因果链、揭晓、每个人对玩家的看法、数字，以及一段可以直接发出去的文案。
   */
  recap() {
    const p = this.sim.player;
    const pid = p?.config.id ?? null;
    const changed = this.blockLog.length;
    const playerBlocks = pid ? this.blockLog.filter((b) => b.agentId === pid) : [];
    const people = this.sim.agents
      .filter((a) => a.kind === 'ai')
      .map((a) => ({
        id: a.config.id,
        name: a.config.name,
        tier: a.config.tier ?? 'extra',
        color: a.config.color,
        public: a.config.role?.public ?? '',
        wish: a.wish,
        trust: pid ? (a.relations[pid]?.trust ?? 0) : 0,
        notes: pid ? (a.relations[pid]?.notes ?? []) : [],
        epilogue: this.ending?.epilogues.find((e) => e.id === a.config.id)?.text ?? null,
      }))
      .sort((x, y) => Number(y.tier === 'core') - Number(x.tier === 'core') || Math.abs(y.trust) - Math.abs(x.trust));
    const touched = pid ? this.timeline.filter((l) => l.includes(p!.config.name)).length : 0;
    const stats = p?.stats ?? null;
    const headline = this.ending ? `《${this.ending.title}》` : '《未完的故事》';
    const shareLines = [
      `${this.scenario.name} · ${headline}`,
      p ? `我是${p.config.name}，在这里过了 ${this.sim.clock.day} 天。` : `居民们过了 ${this.sim.clock.day} 天。`,
      ...this.chapters.map((c) => c.title),
      stats ? `帮过 ${stats.gives} 次人，私聊 ${stats.whispers} 次，偷过 ${stats.steals} 次，被抓 ${stats.caught} 次；亲手改了 ${playerBlocks.length} 块方块。` : '',
      people.filter((x) => x.tier === 'core' && x.trust >= 25).length ? `把我当自己人的：${people.filter((x) => x.tier === 'core' && x.trust >= 25).map((x) => x.name).join('、')}` : '',
      '—— AI小镇',
    ].filter(Boolean);
    return {
      id: this.id,
      status: this.status,
      scenario: { id: this.scenario.id, name: this.scenario.name, genre: this.scenario.genre },
      mode: this.mode,
      days: this.sim.clock.day,
      player: p ? { id: p.config.id, name: p.config.name, public: p.config.role?.public ?? '', wish: p.wish, color: p.config.color } : null,
      ending: this.ending,
      chapters: this.chapters,
      stats,
      world: { size: this.sim.world.size, before: this.worldStart, after: this.sim.world.toBase64(), changedBlocks: changed, playerBlocks },
      people,
      touchedEvents: touched,
      causal: this.causal.filter((c) => c.because).slice(-40),
      highlights: this.timeline.filter((l) => /【事件|被.*当场抓住|悄悄对|给了/.test(l)).slice(-30),
      shareText: shareLines.join('\n'),
    };
  }

  // —— 存档 ——
  save() {
    try {
      mkdirSync(SAVE_DIR, { recursive: true });
      const data: SaveFile = {
        id: this.id,
        savedAt: Date.now(),
        options: this.options,
        scenario: this.scenario,
        status: this.status,
        chapters: this.chapters,
        ending: this.ending,
        timeline: this.timeline,
        causal: this.causal,
        blockLog: this.blockLog,
        worldStart: this.worldStart,
        frames: this.frames,
        eventLog: this.eventLog,
        cost: this.meter.toState(),
        recentTitles: this.recentTitles,
        nextStoryAt: this.nextStoryAt,
        bigEventDone: this.bigEventDone,
        trackDone: [...this.trackDone],
        revealed: [...this.storyteller.revealed],
        sim: this.sim.exportState(),
      };
      writeFileSync(resolve(SAVE_DIR, `${safeName(this.id)}.json`), JSON.stringify(data));
    } catch (err) {
      console.warn('[存档] 写入失败:', (err as Error).message);
    }
  }

  static load(file: string, catalog: ModelCatalog): GameSession {
    const base = safeName(file.replace(/\.json$/, ''));
    const path = resolve(SAVE_DIR, `${base}.json`);
    if (!base || base === 'endings' || !existsSync(path)) throw new Error('没有这个存档');
    const data = JSON.parse(readFileSync(path, 'utf8')) as SaveFile;
    if (!data || typeof data !== 'object' || !data.sim || !data.scenario) throw new Error('存档文件坏了');
    // 存档里的剧本已经合并过沙盒自定义，读档时不要再合并一次
    const options: GameOptions = { ...data.options, sandbox: data.options.sandbox ? { ...data.options.sandbox, customText: undefined, extraRoles: undefined, removeRoles: undefined } : undefined };
    const g = new GameSession(data.scenario, options, catalog, data.id);
    g.sim.importState(data.sim);
    g.chapters = data.chapters ?? [];
    g.ending = data.ending ?? null;
    g.timeline = data.timeline ?? [];
    g.causal = data.causal ?? [];
    g.blockLog = data.blockLog ?? [];
    g.frames = Array.isArray(data.frames) ? data.frames : [];
    g.eventLog = Array.isArray(data.eventLog) ? data.eventLog : [];
    g.meter.restore(data.cost);
    g.lastLevel = g.meter.level;
    g.lastContactAt = g.sim.elapsedMs;
    g.periodStartAt = g.sim.elapsedMs;
    g.storyThisPeriod = true;
    g.storyteller.budgetExhausted = g.meter.level === 'over';
    if (typeof data.worldStart === 'string' && data.worldStart) g.worldStart = data.worldStart;
    g.recentTitles = data.recentTitles ?? [];
    g.nextStoryAt = data.nextStoryAt ?? g.sim.elapsedMs + 60_000;
    g.bigEventDone = !!data.bigEventDone;
    g.trackDone = new Set(data.trackDone ?? []);
    for (const i of data.revealed ?? []) g.storyteller.revealed.add(i);
    g.status = data.status === 'ended' ? 'ended' : 'running';
    const c = g.clockAt(g.sim.elapsedMs);
    g.sim.clock = c;
    g.lastDay = c.day;
    g.lastPhase = c.phase;
    g.lastAutosave = g.sim.elapsedMs;
    if (g.status === 'ended') g.sim.frozen = true;
    return g;
  }

  /** 读档后继续：不再发开场事件 */
  resume() {
    if (this.status !== 'running') return;
    this.sim.emit({ kind: 'game', t: Date.now(), text: `读取了存档，回到第 ${this.sim.clock.day} 天。`, day: this.sim.clock.day, phase: this.sim.clock.phase });
    this.sim.start();
  }

  static listSaves() {
    if (!existsSync(SAVE_DIR)) return [];
    return readdirSync(SAVE_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'endings.json')
      .map((f) => {
        try {
          const d = JSON.parse(readFileSync(resolve(SAVE_DIR, f), 'utf8')) as SaveFile;
          const player = d.sim.agents.find((a) => a.id === (d.options.playerRole === 'player' ? d.scenario.player.id : d.options.playerRole));
          return { file: f.replace(/\.json$/, ''), id: d.id, savedAt: d.savedAt, scenarioName: d.scenario.name, mode: d.options.mode, status: d.status, playerName: player ? d.options.playerName ?? d.scenario.player.name : null, days: d.status === 'ended' ? Math.max(1, d.chapters.length) : d.chapters.length + 1 };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b!.savedAt - a!.savedAt);
  }

  private recordEnding() {
    if (!this.ending) return;
    try {
      mkdirSync(SAVE_DIR, { recursive: true });
      const list = GameSession.listEndings();
      const p = this.sim.player;
      list.unshift({
        gameId: this.id,
        at: Date.now(),
        scenarioId: this.scenario.id,
        scenarioName: this.scenario.name,
        mode: this.mode,
        playerName: p?.config.name ?? null,
        days: this.sim.clock.day,
        title: this.ending.title,
        text: this.ending.text,
        epilogues: this.ending.epilogues,
        chain: this.ending.chain,
        reveals: this.ending.reveals,
        chapters: this.chapters,
        stats: p?.stats ?? null,
      });
      writeFileSync(ENDINGS_FILE(), JSON.stringify(list.slice(0, 200)));
    } catch (err) {
      console.warn('[结局图鉴] 写入失败:', (err as Error).message);
    }
  }

  static listEndings(): any[] {
    try {
      return existsSync(ENDINGS_FILE()) ? (JSON.parse(readFileSync(ENDINGS_FILE(), 'utf8')) as any[]) : [];
    } catch {
      return [];
    }
  }
}

const safeName = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 80);

/** 调用记录开关：CALL_LOG_DIR=<目录> 或 CALL_LOG=1（写到 saves/calls/）；都没设就不记 */
function callLogFor(gameId: string): CallLog | null {
  const dir = process.env.CALL_LOG_DIR?.trim() || (process.env.CALL_LOG && !/^(0|false|no|)$/i.test(process.env.CALL_LOG.trim()) ? resolve(SAVE_DIR, 'calls') : '');
  if (!dir) return null;
  try {
    return new CallLog(resolve(dir, `${safeName(gameId)}.jsonl`));
  } catch (e) {
    console.warn(`[调用记录] 建不了目录 ${dir}：${(e as Error).message}，这局不记录`);
    return null;
  }
}

const wrap1 = <T extends ModelAdapter | null>(a: T, wrap: (x: ModelAdapter) => ModelAdapter): T => (a ? (wrap(a) as T) : a);
