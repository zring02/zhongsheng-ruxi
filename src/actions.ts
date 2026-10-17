import { describeFeeling } from './memory.js';
import { cheb, isDaytime } from './perception.js';
import type { Action, AgentState, BlockTarget, Facing, GamePhase, Landmark, Vec3, WorldEvent } from './types.js';
import { FACING_CN, FACING_VEC, FACINGS } from './types.js';
import { BLOCK, blockById, blockByName, type VoxelWorld } from './voxel.js';

/** 动作处理器拿到的世界接口（由 Simulation 提供） */
export interface ActionContext {
  now: number;
  world: VoxelWorld;
  agents: AgentState[];
  landmarks: Landmark[];
  phase: GamePhase;
  /** 箱子里的东西：key = "x,y,z" */
  chests: Map<string, Record<string, number>>;
  /** 本剧本对被抓现行的罚法说法 */
  penalties: { steal: string; eavesdrop: string };
  /** 难度对被发现概率的加减（宽厚 −0.1 / 寻常 0 / 精明 +0.1） */
  detectDelta: number;
  /** 本剧本的游戏币 */
  currency: { name: string; start: number; askCost: number };
  /** 本剧本开了哪些功能 */
  features: { wechat: boolean };
  /** 写好的信：东西名 → 内容（信是身上的一件东西，谁拿到谁能拆） */
  letters: Map<string, { from: string; to: string; text: string }>;
  nameOf(id: string): string;
  /** 让某人“听到”一句话（进他的刚才听到的，并叫醒他） */
  hear(agentId: string, line: string, reason?: string): void;
  rnd(): number;
  emit(ev: WorldEvent): void;
  /** 改方块并通知前端 */
  setBlock(pos: Vec3, id: number): void;
  /** 让某人尽快思考（事件驱动唤醒） */
  wake(agentId: string): void;
  /** 调整 a 对 otherId 的信任，顺手记一条事 */
  trust(a: AgentState, otherId: string, delta: number, note?: string): void;
  /** 关押一段时间 */
  jail(agent: AgentState, ms: number): void;
  /** 过一会儿做一件事（例如失主发觉东西丢了） */
  later(ms: number, fn: () => void): void;
  /** 正在托人打听、还没回话的（谁>打听谁>关于谁） */
  pendingAsks: Set<string>;
}

/**
 * 动作处理器。想加新动作，在 types.ts 的 Action 里加类型，然后在下面的 ACTIONS 里注册一个处理器即可，
 * 提示词里的动作说明会自动带上。玩家的动作也走同一套处理器。
 */
export interface ActionHandler {
  type: Action['type'];
  /** 给模型看的一行说明 + JSON 示例（可以是函数，方便引用运行时数据） */
  doc: string | ((o: DocOpts) => string);
  /** 这个动作在本剧本里是否可用（例如微信只有现代剧本有）；不写 = 总可用 */
  when?: (o: DocOpts) => boolean;
  /** 校验并规范化模型给出的原始 JSON；参数不合法时返回一句原因（字符串），会作为 fail 事件进入角色记忆 */
  parse(raw: any): Action | string;
  /** 执行动作，返回该角色在多少毫秒内不再决策；Infinity 表示等走完 */
  apply(ctx: ActionContext, agent: AgentState, action: Action): number;
  /** 被关着的时候还能不能做 */
  allowedInJail?: boolean;
}

/** 生成动作说明时要知道的本局信息 */
export interface DocOpts {
  features: { wechat: boolean };
  currency: { name: string; askCost: number };
}
export const DEFAULT_DOC_OPTS: DocOpts = { features: { wechat: false }, currency: { name: '钱', askCost: 5 } };

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const TARGETS: BlockTarget[] = ['front', 'front_up', 'front_down'];
const BREAKABLE_NAMES = () => Object.keys(BLOCK).filter((n) => blockByName(n)!.breakable);
export const chestKey = (p: Vec3) => `${p.x},${p.y},${p.z}`;
/** 私聊、给东西、偷东西都要在这么近的距离内 */
export const CLOSE_RANGE = 2;
/** 偷听的最大距离 */
export const EAVESDROP_RANGE = 6;
export const EAVESDROP_MS = 60_000;
/** 偷东西被抓关多久 */
export const JAIL_MS = 90_000;

/** 面前那一列的目标格子 */
export function targetCell(agent: AgentState, target: BlockTarget): Vec3 {
  const f = FACING_VEC[agent.facing];
  const dy = target === 'front' ? 0 : target === 'front_up' ? 1 : -1;
  return { x: agent.pos.x + f.x, y: agent.pos.y + dy, z: agent.pos.z + f.z };
}

const fail = (ctx: ActionContext, agent: AgentState, text: string) => {
  ctx.emit({ kind: 'fail', t: ctx.now, agentId: agent.config.id, text });
  return 1500;
};

/** 按 id 或名字找人 */
export function findAgent(agents: AgentState[], ref: string, self?: AgentState): AgentState | undefined {
  const r = ref.trim();
  return agents.find((o) => o !== self && o.alive && (o.config.id === r || o.config.name === r));
}

/** (x,z) 这一列在 y 附近（上下 1 格内）是否有别的角色站着 */
export function isOccupied(agents: AgentState[], self: AgentState | null, p: Vec3): boolean {
  return agents.some((o) => o !== self && o.alive && o.pos.x === p.x && o.pos.z === p.z && Math.abs(o.pos.y - p.y) <= 1);
}

/** (x,z) 这一列是不是别人已经选好的路径终点（避免两个人奔向同一格） */
export function isPathEnd(agents: AgentState[], self: AgentState | null, x: number, z: number): boolean {
  return agents.some((o) => o !== self && o.path.length > 0 && o.path[o.path.length - 1].x === x && o.path[o.path.length - 1].z === z);
}

/** 寻路时把其他角色站着的格子当障碍 */
export const blockedByAgents = (agents: AgentState[], self: AgentState) => (p: Vec3) => isOccupied(agents, self, p);

/**
 * 在 (x,z) 附近挑一个没人站、也不是别人目的地的落脚列（螺旋由近到远）。
 * 找不到就退回 (x,z) 本身
 */
export function freeSpotNear(ctx: Pick<ActionContext, 'world' | 'agents'>, self: AgentState | null, x: number, z: number, maxR = 4): { x: number; z: number } {
  const ok = (cx: number, cz: number) => {
    const y = ctx.world.surfaceY(cx, cz);
    return !isOccupied(ctx.agents, self, { x: cx, y, z: cz }) && !isPathEnd(ctx.agents, self, cx, cz);
  };
  const spot = ctx.world.findGroundSpot(x, z, maxR, ok);
  return spot ? { x: spot.x, z: spot.z } : { x, z };
}

export function facingToward(from: Vec3, to: Vec3): Facing {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx === 0 && dz === 0) return 'south';
  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

/** 物品的中文名：是方块就用方块表里的名字，否则（剧本里的玉佩、信这类）原样 */
export const itemName = (k: string) => blockByName(k)?.cn ?? k;

/** 背包里拿东西：名字可以是方块英文名、中文名或剧本物品名 */
function findItem(inv: Record<string, number>, name: string | null): string | null {
  if (!name) return null;
  const bt = blockByName(name);
  const have = Object.keys(inv).filter((k) => (inv[k] ?? 0) > 0);
  const key = bt && (inv[bt.name] ?? 0) > 0 ? bt.name : have.find((k) => k === name || itemName(k) === name) ?? have.find((k) => k.includes(name) || name.includes(k));
  return key ?? null;
}

/** 信是东西名带“写给…的信”的物品（同一个人写给同一个人的第二封叫“…的第2封信”） */
export const EMOTES = ['wave', 'laugh', 'think', 'sad', 'dance', 'sleep', 'angry', 'love'];

export const isLetter = (key: string) => /写给.+的(第\d+封)?信$/.test(key);

/**
 * 信到了谁手里：收信人到手就读了（letter 事件）；作者拿回自己的信只是拿回；
 * 别人（带信的、偷信的、从箱子里取的）拿到的是一封没拆的信，想看要 read_letter（open=true 时才拆）
 */
export function readLetter(ctx: ActionContext, reader: AgentState, item: string, via?: string, open = false) {
  const letter = ctx.letters.get(item);
  if (!letter) return;
  const mine = letter.to === reader.config.id;
  if (!mine && letter.from === reader.config.id) return void ctx.emit({ kind: 'notice', t: ctx.now, agentId: reader.config.id, text: `你拿回了自己写给${ctx.nameOf(letter.to)}的信。` });
  if (!mine && !open) return void ctx.emit({ kind: 'notice', t: ctx.now, agentId: reader.config.id, text: `你手里多了一封${ctx.nameOf(letter.from)}写给${ctx.nameOf(letter.to)}的信（东西名：${item}），还没拆。可以替他送到，也可以 read_letter 拆开看。` });
  ctx.emit({ kind: 'letter', t: ctx.now, agentId: reader.config.id, from: letter.from, to: letter.to, text: letter.text, item, via: via && via !== letter.from && via !== reader.config.id ? via : undefined });
}

function moveItem(from: Record<string, number>, to: Record<string, number>, key: string, count: number): number {
  const n = Math.min(count, from[key] ?? 0);
  if (n <= 0) return 0;
  from[key] -= n;
  if (from[key] <= 0) delete from[key];
  to[key] = (to[key] ?? 0) + n;
  return n;
}

/** 听得见的旁观者：hearing 范围内、还活着、不是当事人 */
export function bystanders(ctx: ActionContext, around: AgentState, exclude: AgentState[], range: number) {
  return ctx.agents.filter((o) => o.alive && !exclude.includes(o) && cheb(o.pos, around.pos) <= range && Math.abs(o.pos.y - around.pos.y) <= 4);
}

/**
 * 被当场发现的概率（剧情文档里的表）：
 * 偷听 20% / 偷东西 30% 起步；离得很近 +20；白天且旁边人多 +15；对方警觉 +15；对方正专心说话/干活 −15/−10；夜里 −10/−15
 */
export function detectionChance(ctx: ActionContext, actor: AgentState, target: AgentState, what: 'steal' | 'eavesdrop'): number {
  let p = what === 'steal' ? 0.3 : 0.2;
  if (cheb(actor.pos, target.pos) <= 1) p += 0.2;
  if (isDaytime(ctx.phase) && bystanders(ctx, actor, [actor, target], 4).length > 0) p += 0.15;
  if (target.alertness >= 0.6) p += 0.15;
  const busy = target.path.length > 0 || (target.busyUntil > ctx.now && (target.lastAction?.type === 'say' || target.lastAction?.type === 'whisper' || target.lastAction?.type === 'break_block' || target.lastAction?.type === 'place_block'));
  if (busy) p -= what === 'steal' ? 0.1 : 0.15;
  if (ctx.phase === 'night') p -= what === 'steal' ? 0.15 : 0.1;
  p += ctx.detectDelta;
  return Math.min(0.95, Math.max(0.05, p));
}

/** 被抓现行：公开事件 + 信任崩塌 + （偷东西）关押 */
function getCaught(ctx: ActionContext, actor: AgentState, target: AgentState, what: 'steal' | 'eavesdrop', by: AgentState): number {
  const penalty = what === 'steal' ? ctx.penalties.steal : ctx.penalties.eavesdrop;
  actor.stats.caught++;
  actor.eavesdropping = null;
  ctx.trust(target, actor.config.id, what === 'steal' ? -70 : -40, what === 'steal' ? '想偷我东西被我抓住' : '偷听我说话被我撞见');
  for (const o of bystanders(ctx, actor, [actor, target], 10)) ctx.trust(o, actor.config.id, what === 'steal' ? -40 : -20, `${what === 'steal' ? '偷' : '偷听'}${target.config.name}被抓`);
  ctx.emit({ kind: 'caught', t: ctx.now, agentId: actor.config.id, what, target: target.config.id, by: by.config.id, penalty });
  ctx.wake(target.config.id);
  if (what === 'steal') ctx.jail(actor, JAIL_MS);
  return what === 'steal' ? 4000 : 3000;
}

export const ACTIONS: ActionHandler[] = [
  {
    type: 'turn',
    doc: '转身: {"type":"turn","direction":"north|east|south|west|left|right"}',
    parse(raw) {
      const d = str(raw.direction, 10) as Facing | 'left' | 'right' | null;
      return d && (FACINGS.includes(d as Facing) || d === 'left' || d === 'right') ? { type: 'turn', direction: d } : `turn 的 direction“${d ?? ''}”不认识，可用: north|east|south|west|left|right`;
    },
    apply(_ctx, agent, action) {
      const d = (action as Extract<Action, { type: 'turn' }>).direction;
      const i = FACINGS.indexOf(agent.facing);
      agent.facing = d === 'left' ? FACINGS[(i + 3) % 4] : d === 'right' ? FACINGS[(i + 1) % 4] : d;
      return 400;
    },
    allowedInJail: true,
  },
  {
    type: 'move',
    doc: '朝面对的方向走几步(1-6)，遇到挡路的会停下: {"type":"move","steps":3}',
    parse(raw) {
      const s = Number(raw.steps);
      return { type: 'move', steps: Number.isFinite(s) ? Math.min(Math.max(Math.round(s), 1), 6) : 1 };
    },
    apply(ctx, agent, action) {
      const steps = (action as Extract<Action, { type: 'move' }>).steps;
      const path: Vec3[] = [];
      let cur = agent.pos;
      for (let i = 0; i < steps; i++) {
        const next = ctx.world.step(cur, FACING_VEC[agent.facing]);
        if (!next) break;
        if (isOccupied(ctx.agents, agent, next)) break; // 前面站着人，走到他跟前停下
        path.push(next);
        cur = next;
      }
      if (!path.length) {
        const first = ctx.world.step(agent.pos, FACING_VEC[agent.facing]);
        return fail(ctx, agent, first && isOccupied(ctx.agents, agent, first) ? '前面站着人，走不动' : '前方被挡住了，走不动');
      }
      agent.path = path;
      agent.targetName = `${FACING_CN[agent.facing]}边 ${path.length} 格`;
      ctx.emit({ kind: 'move', t: ctx.now, agentId: agent.config.id, target: agent.targetName });
      return Infinity;
    },
  },
  {
    type: 'walk_to',
    doc: '自动寻路走到某个地标或坐标: {"type":"walk_to","target":"<地标id>"} 或 {"type":"walk_to","x":10,"z":12}',
    parse(raw) {
      const target = str(raw.target, 40);
      const x = Number(raw.x);
      const z = Number(raw.z);
      if (target) return { type: 'walk_to', target };
      if (Number.isFinite(x) && Number.isFinite(z)) return { type: 'walk_to', x: Math.round(x), z: Math.round(z) };
      return 'walk_to 需要 target（地标 id）或者 x、z 坐标';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'walk_to' }>;
      let goal: { x: number; z: number };
      let name: string;
      if (a.target !== undefined) {
        const lm = ctx.landmarks.find((l) => l.id === a.target || l.name === a.target);
        if (!lm) {
          // 模型常把人名当地标：顺手当 approach 处理
          const who = findAgent(ctx.agents, a.target, agent);
          if (who) return getHandler('approach')!.apply(ctx, agent, { type: 'approach', target: who.config.id });
          return fail(ctx, agent, `没有叫“${a.target}”的地标`);
        }
        // 不直接站到地标中心那一格，而是在附近挑一个没人占的落脚格，否则去同一地标的人会叠在一起
        goal = freeSpotNear(ctx, agent, lm.pos.x, lm.pos.z);
        name = lm.name;
      } else {
        goal = { x: a.x!, z: a.z! };
        name = `(${goal.x}, ${goal.z})`;
      }
      if (goal.x < 0 || goal.z < 0 || goal.x >= ctx.world.size.x || goal.z >= ctx.world.size.z) return fail(ctx, agent, `${name} 在世界之外`);
      if (a.target === undefined) goal = freeSpotNear(ctx, agent, goal.x, goal.z, 2); // 坐标上有人就站到旁边
      const path = ctx.world.findPath(agent.pos, goal, 3, 30000, blockedByAgents(ctx.agents, agent));
      if (!path) return fail(ctx, agent, `找不到去${name}的路`);
      if (!path.length) {
        ctx.emit({ kind: 'arrive', t: ctx.now, agentId: agent.config.id, target: name });
        return 1000;
      }
      agent.path = path;
      agent.targetName = name;
      agent.faceOnArrive = null;
      ctx.emit({ kind: 'move', t: ctx.now, agentId: agent.config.id, target: name });
      return Infinity;
    },
  },
  {
    type: 'approach',
    doc: '走到某个人跟前并面向他（之后才能私聊、给东西），也可以是地标或方块坐标: {"type":"approach","target":"<人的id>"} 或 {"type":"approach","target":{"x":10,"y":8,"z":12}}',
    parse(raw) {
      const t = raw.target;
      if (t && typeof t === 'object' && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.z))) {
        return { type: 'approach', target: { x: Math.round(Number(t.x)), y: Number.isFinite(Number(t.y)) ? Math.round(Number(t.y)) : 0, z: Math.round(Number(t.z)) } };
      }
      const s = str(t, 40) ?? str(raw.to, 40);
      return s ? { type: 'approach', target: s } : 'approach 需要 target（人的 id、地标 id 或 {x,y,z}）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'approach' }>;
      let goalPos: Vec3;
      let name: string;
      let face: string | Vec3;
      let nearEnough = 1;
      if (typeof a.target === 'string') {
        const who = findAgent(ctx.agents, a.target, agent);
        const lm = who ? null : ctx.landmarks.find((l) => l.id === a.target || l.name === a.target);
        if (who) {
          goalPos = who.pos;
          name = `${who.config.name}跟前`;
          face = who.config.id;
        } else if (lm) {
          const spot = freeSpotNear(ctx, agent, lm.pos.x, lm.pos.z);
          goalPos = { x: spot.x, y: 0, z: spot.z };
          name = lm.name;
          face = lm.pos;
          nearEnough = 3;
        } else return fail(ctx, agent, `附近没有叫“${a.target}”的人或地标`);
      } else {
        goalPos = a.target;
        name = `(${a.target.x}, ${a.target.z})`;
        face = a.target;
        if (!ctx.world.inBounds(a.target.x, Math.max(0, a.target.y), a.target.z)) return fail(ctx, agent, `${name} 在世界之外`);
      }
      // 已经在跟前：只转身
      if (cheb(agent.pos, goalPos) <= nearEnough && (typeof face !== 'string' || cheb(agent.pos, goalPos) >= 1)) {
        agent.facing = facingToward(agent.pos, goalPos);
        ctx.emit({ kind: 'arrive', t: ctx.now, agentId: agent.config.id, target: name });
        return 600;
      }
      const path = ctx.world.findPath(agent.pos, goalPos, nearEnough, 30000, blockedByAgents(ctx.agents, agent));
      if (!path) return fail(ctx, agent, `找不到去${name}的路`);
      if (!path.length) {
        agent.facing = facingToward(agent.pos, goalPos);
        ctx.emit({ kind: 'arrive', t: ctx.now, agentId: agent.config.id, target: name });
        return 600;
      }
      agent.path = path;
      agent.targetName = name;
      agent.faceOnArrive = face;
      ctx.emit({ kind: 'move', t: ctx.now, agentId: agent.config.id, target: name });
      return Infinity;
    },
  },
  {
    type: 'break_block',
    doc: '挖掉面前的方块，挖到的进背包。target: front=面前脚下高度, front_up=面前头顶高度, front_down=面前的地面: {"type":"break_block","target":"front"}',
    parse(raw) {
      const t = str(raw.target, 12) as BlockTarget | null;
      return { type: 'break_block', target: t && TARGETS.includes(t) ? t : 'front' };
    },
    apply(ctx, agent, action) {
      const cell = targetCell(agent, (action as Extract<Action, { type: 'break_block' }>).target);
      const bt = blockById(ctx.world.get(cell.x, cell.y, cell.z));
      if (!bt.solid) return fail(ctx, agent, '面前那里没有方块可挖');
      if (!bt.breakable || !ctx.world.inBounds(cell.x, cell.y, cell.z)) return fail(ctx, agent, `${bt.cn}挖不动`);
      ctx.setBlock(cell, BLOCK.air);
      agent.inventory[bt.name] = (agent.inventory[bt.name] ?? 0) + 1;
      ctx.emit({ kind: 'block', t: ctx.now, agentId: agent.config.id, op: 'break', block: bt.name, pos: cell });
      return 1500;
    },
  },
  {
    type: 'place_block',
    doc: () => `把背包里的方块放到面前（target 同上）: {"type":"place_block","block":"plank","target":"front"}，方块名: ${BREAKABLE_NAMES().join('|')}`,
    parse(raw) {
      const b = str(raw.block, 20);
      if (!b) return `place_block 缺少 block（方块名），可用: ${BREAKABLE_NAMES().join('|')}`;
      const bt = blockByName(b);
      if (!bt || !bt.solid || !bt.breakable) return `place_block 的方块名“${b}”不认识或不能放置，可用: ${BREAKABLE_NAMES().join('|')}`;
      const t = str(raw.target, 12) as BlockTarget | null;
      return { type: 'place_block', block: bt.name, target: t && TARGETS.includes(t) ? t : 'front' };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'place_block' }>;
      const bt = blockByName(a.block)!;
      if ((agent.inventory[bt.name] ?? 0) <= 0) return fail(ctx, agent, `背包里没有${bt.cn}`);
      const cell = targetCell(agent, a.target);
      if (!ctx.world.inBounds(cell.x, cell.y, cell.z)) return fail(ctx, agent, '那里超出了世界边界');
      if (ctx.world.get(cell.x, cell.y, cell.z) !== BLOCK.air) return fail(ctx, agent, '那里已经有方块了');
      if (ctx.agents.some((o) => o.alive && o.pos.x === cell.x && o.pos.z === cell.z && (o.pos.y === cell.y || o.pos.y + 1 === cell.y))) return fail(ctx, agent, '有人站在那里');
      const w = ctx.world;
      const supported = w.isSolid(cell.x, cell.y - 1, cell.z) || w.isSolid(cell.x, cell.y + 1, cell.z) || w.isSolid(cell.x + 1, cell.y, cell.z) || w.isSolid(cell.x - 1, cell.y, cell.z) || w.isSolid(cell.x, cell.y, cell.z + 1) || w.isSolid(cell.x, cell.y, cell.z - 1);
      if (!supported) return fail(ctx, agent, '那里悬空，没有可以依附的方块');
      ctx.setBlock(cell, bt.id);
      agent.inventory[bt.name]--;
      if (agent.inventory[bt.name] <= 0) delete agent.inventory[bt.name];
      ctx.emit({ kind: 'block', t: ctx.now, agentId: agent.config.id, op: 'place', block: bt.name, pos: cell });
      return 1500;
    },
  },
  {
    type: 'say',
    doc: '说一句话，附近 10 格内的人都能听到（不是私聊）；to 表明你在对谁说: {"type":"say","text":"<内容>","to":"<可选，对方id>"}',
    parse(raw) {
      const text = str(raw.text, 300);
      return text ? { type: 'say', text, to: str(raw.to, 40) ?? undefined } : 'say 缺少 text（要说的内容）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'say' }>;
      const to = a.to ? findAgent(ctx.agents, a.to, agent)?.config.id : undefined;
      agent.stats.says++;
      ctx.emit({ kind: 'say', t: ctx.now, agentId: agent.config.id, text: a.text, to });
      return 2500 + a.text.length * 60; // 说话时间与长度相关，气泡显示用
    },
    allowedInJail: true,
  },
  {
    type: 'whisper',
    doc: `私聊：对跟前（${CLOSE_RANGE} 格内）的人说悄悄话，只有他听得到，但旁边 3 格内的人可能听去几个字，偷听的人可能全听到: {"type":"whisper","to":"<对方id>","text":"<内容>"}`,
    parse(raw) {
      const to = str(raw.to, 40) ?? str(raw.target, 40);
      const text = str(raw.text, 300);
      if (!to) return 'whisper 缺少 to（对方 id）';
      if (!text) return 'whisper 缺少 text（要说的内容）';
      return { type: 'whisper', to, text };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'whisper' }>;
      const who = findAgent(ctx.agents, a.to, agent);
      if (!who) return fail(ctx, agent, `附近没有叫“${a.to}”的人`);
      if (cheb(agent.pos, who.pos) > CLOSE_RANGE) return fail(ctx, agent, `${who.config.name}不在你跟前，先 approach 走过去`);
      // 偷听者：正在偷听说话双方之一、在偷听距离内；每次私聊都再掷一次（概率减半）被发现
      const overheardBy: string[] = [];
      for (const spy of ctx.agents) {
        if (spy === agent || spy === who || !spy.alive || !spy.eavesdropping || spy.eavesdropUntil < ctx.now) continue;
        if (spy.eavesdropping !== agent.config.id && spy.eavesdropping !== who.config.id) continue;
        const target = spy.eavesdropping === agent.config.id ? agent : who;
        if (cheb(spy.pos, target.pos) > EAVESDROP_RANGE) continue;
        if (ctx.rnd() < detectionChance(ctx, spy, target, 'eavesdrop') * 0.5) {
          getCaught(ctx, spy, target, 'eavesdrop', target);
          continue;
        }
        overheardBy.push(spy.config.id);
      }
      agent.stats.whispers++;
      ctx.trust(who, agent.config.id, 3);
      const relayTo = typeof (action as { relayTo?: unknown }).relayTo === 'string' ? ((action as { relayTo?: string }).relayTo as string) : undefined;
      ctx.emit({ kind: 'whisper', t: ctx.now, agentId: agent.config.id, to: who.config.id, text: a.text, overheardBy: overheardBy.length ? overheardBy : undefined, relayTo });
      return 2500 + a.text.length * 60;
    },
    allowedInJail: true,
  },
  {
    type: 'eavesdrop',
    doc: `偷听：盯住 ${EAVESDROP_RANGE} 格内的某个人一分钟，能听到他的私聊；可能被发现: {"type":"eavesdrop","target":"<对方id>"}`,
    parse(raw) {
      const t = str(raw.target, 40) ?? str(raw.to, 40);
      return t ? { type: 'eavesdrop', target: t } : 'eavesdrop 缺少 target（对方 id）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'eavesdrop' }>;
      const who = findAgent(ctx.agents, a.target, agent);
      if (!who) return fail(ctx, agent, `附近没有叫“${a.target}”的人`);
      if (cheb(agent.pos, who.pos) > EAVESDROP_RANGE) return fail(ctx, agent, `${who.config.name}太远了，听不到`);
      if (ctx.rnd() < detectionChance(ctx, agent, who, 'eavesdrop')) return getCaught(ctx, agent, who, 'eavesdrop', who);
      agent.eavesdropping = who.config.id;
      agent.eavesdropUntil = ctx.now + EAVESDROP_MS;
      agent.facing = facingToward(agent.pos, who.pos);
      ctx.emit({ kind: 'sneak', t: ctx.now, agentId: agent.config.id, what: 'eavesdrop', target: who.config.id, text: `开始偷听${who.config.name}` });
      return 3000;
    },
  },
  {
    type: 'steal',
    doc: `偷东西：从跟前（${CLOSE_RANGE} 格内）的人身上摸一件东西，可能被当场抓住: {"type":"steal","target":"<对方id>","item":"<可选，想偷的东西>"}`,
    parse(raw) {
      const t = str(raw.target, 40) ?? str(raw.to, 40);
      return t ? { type: 'steal', target: t, item: str(raw.item, 30) ?? undefined } : 'steal 缺少 target（对方 id）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'steal' }>;
      const who = findAgent(ctx.agents, a.target, agent);
      if (!who) return fail(ctx, agent, `附近没有叫“${a.target}”的人`);
      if (cheb(agent.pos, who.pos) > CLOSE_RANGE) return fail(ctx, agent, `${who.config.name}不在你跟前，先 approach 走过去`);
      const keys = Object.keys(who.inventory).filter((k) => (who.inventory[k] ?? 0) > 0);
      if (!keys.length) return fail(ctx, agent, `${who.config.name}身上什么都没有`);
      const key = findItem(who.inventory, a.item ?? null) ?? keys[Math.floor(ctx.rnd() * keys.length)];
      // 先掷骰子：被抓就什么都拿不到
      const witnesses = bystanders(ctx, agent, [agent, who], 4);
      const catcher = ctx.rnd() < detectionChance(ctx, agent, who, 'steal') ? (who.path.length || who.thinking ? witnesses[0] ?? who : who) : null;
      if (catcher) return getCaught(ctx, agent, who, 'steal', catcher);
      moveItem(who.inventory, agent.inventory, key, 1);
      if (isLetter(key)) readLetter(ctx, agent, key);
      agent.stats.steals++;
      ctx.emit({ kind: 'sneak', t: ctx.now, agentId: agent.config.id, what: 'steal', target: who.config.id, item: key, text: `从${who.config.name}身上摸走了${itemName(key)}` });
      // 失主过一会儿会发觉东西少了，开始怀疑当时在旁边的人
      const suspects = [agent, ...witnesses].map((o) => o.config.id);
      ctx.later(60_000 + ctx.rnd() * 120_000, () => {
        if (!who.alive) return;
        const names = suspects.map((id) => ctx.agents.find((o) => o.config.id === id)?.config.name ?? id);
        ctx.emit({ kind: 'notice', t: Date.now(), agentId: who.config.id, text: `你发觉身上的${itemName(key)}不见了。当时在旁边的有：${names.join('、')}` });
        for (const id of suspects) ctx.trust(who, id, -10, `我丢${itemName(key)}的时候他在旁边`);
        ctx.wake(who.config.id);
      });
      return 3000;
    },
  },
  {
    type: 'give',
    doc: `把背包里的东西给跟前（${CLOSE_RANGE} 格内）的人: {"type":"give","to":"<对方id>","item":"<东西名>","count":1}`,
    parse(raw) {
      const to = str(raw.to, 40) ?? str(raw.target, 40);
      const item = str(raw.item, 30);
      if (!to) return 'give 缺少 to（对方 id）';
      if (!item) return 'give 缺少 item（东西名）';
      const n = Number(raw.count);
      return { type: 'give', to, item, count: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 64) : 1 };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'give' }>;
      const who = findAgent(ctx.agents, a.to, agent);
      if (!who) return fail(ctx, agent, `附近没有叫“${a.to}”的人`);
      if (cheb(agent.pos, who.pos) > CLOSE_RANGE) return fail(ctx, agent, `${who.config.name}不在你跟前，先 approach 走过去`);
      const key = findItem(agent.inventory, a.item);
      if (!key) return fail(ctx, agent, `你身上没有${a.item}`);
      const n = moveItem(agent.inventory, who.inventory, key, a.count ?? 1);
      agent.stats.gives++;
      const letter = isLetter(key);
      if (!letter) {
        // 礼越送越不值钱：第一次 +15，之后递减；送游戏币要送到“打听一次的价钱”才算一份整礼
        const given = who.relations[agent.config.id]?.gifts ?? 0;
        let bonus = Math.max(2, Math.round(15 / (1 + given)));
        if (key === ctx.currency.name) bonus = Math.max(1, Math.round(bonus * Math.min(1, n / Math.max(1, ctx.currency.askCost))));
        ctx.trust(who, agent.config.id, bonus, `送了我${itemName(key)}${n > 1 ? `×${n}` : ''}`);
        const rel = who.relations[agent.config.id];
        if (rel) rel.gifts = given + 1;
      }
      ctx.emit({ kind: 'give', t: ctx.now, agentId: agent.config.id, to: who.config.id, item: key, count: n });
      if (letter) readLetter(ctx, who, key, agent.config.id);
      ctx.wake(who.config.id);
      return 2000;
    },
  },
  {
    type: 'put',
    doc: '把东西放进面前的箱子: {"type":"put","item":"<东西名>","count":1}',
    parse(raw) {
      const item = str(raw.item, 30);
      const n = Number(raw.count);
      return item ? { type: 'put', item, count: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 64) : 1 } : 'put 缺少 item（东西名）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'put' }>;
      const cell = chestInFront(ctx, agent);
      if (!cell) return fail(ctx, agent, '面前没有箱子（要面向箱子站着）');
      const key = findItem(agent.inventory, a.item);
      if (!key) return fail(ctx, agent, `你身上没有${a.item}`);
      const chest = ctx.chests.get(chestKey(cell)) ?? {};
      const n = moveItem(agent.inventory, chest, key, a.count ?? 1);
      ctx.chests.set(chestKey(cell), chest);
      ctx.emit({ kind: 'chest', t: ctx.now, agentId: agent.config.id, op: 'put', item: key, count: n, pos: cell });
      return 1500;
    },
  },
  {
    type: 'take',
    doc: '从面前的箱子里取东西: {"type":"take","item":"<东西名>","count":1}',
    parse(raw) {
      const item = str(raw.item, 30);
      const n = Number(raw.count);
      return item ? { type: 'take', item, count: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 64) : 1 } : 'take 缺少 item（东西名）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'take' }>;
      const cell = chestInFront(ctx, agent);
      if (!cell) return fail(ctx, agent, '面前没有箱子（要面向箱子站着）');
      const chest = ctx.chests.get(chestKey(cell)) ?? {};
      const key = findItem(chest, a.item);
      if (!key) {
        const has = Object.entries(chest).filter(([, n]) => n > 0);
        return fail(ctx, agent, has.length ? `箱子里没有${a.item}，只有：${has.map(([k, n]) => `${itemName(k)}×${n}`).join('、')}` : '箱子是空的');
      }
      const n = moveItem(chest, agent.inventory, key, a.count ?? 1);
      ctx.emit({ kind: 'chest', t: ctx.now, agentId: agent.config.id, op: 'take', item: key, count: n, pos: cell });
      if (isLetter(key)) readLetter(ctx, agent, key, 'chest');
      return 1500;
    },
  },
  {
    type: 'emote',
    doc: '做一个表情或动作: {"type":"emote","emote":"wave|laugh|think|sad|dance|sleep|angry|love"}',
    parse(raw) {
      const emote = str(raw.emote, 20);
      if (!emote) return 'emote 缺少 emote（动作名），例如 wave|laugh|think|sad|dance|sleep';
      if (!EMOTES.includes(emote)) return `emote“${emote}”不认识，只能是 ${EMOTES.join('|')}`;
      return { type: 'emote', emote };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'emote' }>;
      agent.emote = a.emote;
      ctx.emit({ kind: 'emote', t: ctx.now, agentId: agent.config.id, emote: a.emote });
      return 3000;
    },
    allowedInJail: true,
  },
  {
    type: 'idle',
    doc: '原地待一会儿: {"type":"idle","seconds":5}',
    parse(raw) {
      const s = Number(raw.seconds);
      return { type: 'idle', seconds: Number.isFinite(s) ? Math.min(Math.max(s, 1), 30) : 5 };
    },
    apply(_ctx, _agent, action) {
      return ((action as Extract<Action, { type: 'idle' }>).seconds ?? 5) * 1000;
    },
    allowedInJail: true,
  },
  {
    type: 'ask_around',
    doc: (o) => `花 ${o.currency.askCost} ${o.currency.name}托人打听某人对你（或对别人）的看法——好感、信不信、记得你什么: {"type":"ask_around","target":"<对方id>","about":"<可选：打听他对谁的看法，不填就是对你>"}`,
    parse(raw) {
      const t = str(raw.target, 40) ?? str(raw.to, 40);
      return t ? { type: 'ask_around', target: t, about: str(raw.about, 40) ?? undefined } : 'ask_around 缺少 target（对方 id）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'ask_around' }>;
      const who = findAgent(ctx.agents, a.target, agent);
      if (!who) return fail(ctx, agent, `没有叫“${a.target}”的人`);
      const about = a.about ? findAgent(ctx.agents, a.about) : agent;
      if (!about) return fail(ctx, agent, `没有叫“${a.about}”的人`);
      if (about === who) return fail(ctx, agent, `${who.config.name}对自己的看法不用打听`);
      const pendingKey = `${agent.config.id}>${who.config.id}>${about.config.id}`;
      if (ctx.pendingAsks.has(pendingKey)) return fail(ctx, agent, `你托的人还没回话，先等等`);
      const cost = ctx.currency.askCost;
      const key = findItem(agent.inventory, ctx.currency.name);
      if (cost > 0 && (!key || (agent.inventory[key] ?? 0) < cost)) return fail(ctx, agent, `你身上的${ctx.currency.name}不够，打听一次要 ${cost}`);
      if (cost > 0 && key) {
        agent.inventory[key] -= cost;
        if (agent.inventory[key] <= 0) delete agent.inventory[key];
      }
      const aboutName = about === agent ? '你' : about.config.name;
      const aboutRef = about;
      ctx.pendingAsks.add(pendingKey);
      ctx.emit({ kind: 'notice', t: ctx.now, agentId: agent.config.id, text: `你花了 ${cost} ${ctx.currency.name}托人去打听${who.config.name}对${aboutName}的看法，等回话。` });
      // 打听要一会儿才有回音；回话时按那时的看法说。只说他亲身记得的事，道听途说的不算
      ctx.later(5_000 + ctx.rnd() * 10_000, () => {
        ctx.pendingAsks.delete(pendingKey);
        if (!agent.alive) return;
        const rel = who.relations[aboutRef.config.id];
        const feeling = describeFeeling(aboutName, rel?.affection ?? 0, rel?.trust ?? 0, !!rel?.distrust);
        const notes = (rel?.notes ?? []).filter((n) => !n.startsWith('听说')).slice(-2);
        ctx.emit({ kind: 'notice', t: ctx.now, agentId: agent.config.id, text: `托的人回话了：${who.config.name}${feeling}${notes.length ? `。${who.config.name}记得${aboutName}：${notes.join('；')}` : ''}` });
      });
      // 打听的事有两成会传到当事人耳朵里
      if (ctx.rnd() < 0.2) ctx.emit({ kind: 'notice', t: ctx.now, agentId: who.config.id, text: `有人向你打听你对${about === agent ? agent.config.name : aboutName}怎么看。` });
      return 2500;
    },
    allowedInJail: true,
  },
  {
    type: 'pass_message',
    doc: `传话：让跟前（${CLOSE_RANGE} 格内）的人把一句话带给第三个人（带不带、怎么带，看那个人）: {"type":"pass_message","via":"<带话的人id>","to":"<收话的人id>","text":"…"}`,
    parse(raw) {
      const via = str(raw.via, 40) ?? str(raw.through, 40);
      const to = str(raw.to, 40) ?? str(raw.target, 40);
      const text = str(raw.text, 120);
      if (!via) return 'pass_message 缺少 via（带话的人 id）';
      if (!to) return 'pass_message 缺少 to（收话的人 id）';
      if (!text) return 'pass_message 缺少 text';
      return { type: 'pass_message', via, to, text };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'pass_message' }>;
      const via = findAgent(ctx.agents, a.via, agent);
      if (!via) return fail(ctx, agent, `附近没有叫“${a.via}”的人`);
      const to = findAgent(ctx.agents, a.to, agent);
      if (!to) return fail(ctx, agent, `没有叫“${a.to}”的人`);
      if (to === via) return fail(ctx, agent, `${via.config.name}就在跟前，直接 whisper 就行`);
      if (cheb(agent.pos, via.pos) > CLOSE_RANGE) return fail(ctx, agent, `${via.config.name}不在你跟前，先 approach 走过去`);
      // 本质是一句悄悄话，走私聊的流程（可能被偷听）；relayTo 让带话的人听到的是“某某托你告诉某某：「原话」”
      return getHandler('whisper')!.apply(ctx, agent, { type: 'whisper', to: via.config.id, text: a.text, relayTo: to.config.id } as Action);
    },
    allowedInJail: true,
  },
  {
    type: 'write_letter',
    doc: '写信：写好的信是身上的一件东西（“你写给某人的信”），可以亲手 give、托人 give、放进箱子，也可能被偷、被别人拆开: {"type":"write_letter","to":"<收信人id>","text":"…"}',
    parse(raw) {
      const to = str(raw.to, 40) ?? str(raw.target, 40);
      const text = str(raw.text, 200);
      if (!to) return 'write_letter 缺少 to（收信人 id）';
      if (!text) return 'write_letter 缺少 text（信的内容）';
      return { type: 'write_letter', to, text };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'write_letter' }>;
      const to = ctx.agents.find((o) => o !== agent && (o.config.id === a.to.trim() || o.config.name === a.to.trim()));
      if (!to) return fail(ctx, agent, `没有叫“${a.to}”的人`);
      const base = `${agent.config.name}写给${to.config.name}的信`;
      let item = base;
      for (let n = 2; ctx.letters.has(item) || agent.inventory[item]; n++) item = `${agent.config.name}写给${to.config.name}的第${n}封信`;
      agent.inventory[item] = 1;
      ctx.letters.set(item, { from: agent.config.id, to: to.config.id, text: a.text });
      ctx.emit({ kind: 'notice', t: ctx.now, agentId: agent.config.id, text: `你写好了一封给${to.config.name}的信，揣在身上（东西名：${item}）。可以亲手给他、托人带去，或放进箱子。` });
      return 4000;
    },
    allowedInJail: true,
  },
  {
    type: 'read_letter',
    doc: '拆信：拆开手里一封不是写给你的信看看（写给你的信到手就看了）: {"type":"read_letter","item":"<信的东西名>"}',
    parse(raw) {
      const item = str(raw.item, 60) ?? str(raw.target, 60);
      return item ? { type: 'read_letter', item } : 'read_letter 缺少 item（信的东西名）';
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'read_letter' }>;
      const held = Object.keys(agent.inventory).filter((k) => isLetter(k) && (agent.inventory[k] ?? 0) > 0);
      const key = findItem(agent.inventory, a.item) ?? (held.length === 1 ? held[0] : null);
      if (!key || !isLetter(key) || !ctx.letters.has(key)) return fail(ctx, agent, `你手里没有叫“${a.item}”的信`);
      readLetter(ctx, agent, key, undefined, true);
      return 3000;
    },
    allowedInJail: true,
  },
  {
    type: 'wechat',
    when: (o) => o.features.wechat,
    doc: '发微信：不用在跟前，只有对方看得到（但他可以转述）: {"type":"wechat","to":"<对方id>","text":"…"}',
    parse(raw) {
      const to = str(raw.to, 40) ?? str(raw.target, 40);
      const text = str(raw.text, 200);
      if (!to) return 'wechat 缺少 to（对方 id）';
      if (!text) return 'wechat 缺少 text';
      return { type: 'wechat', to, text };
    },
    apply(ctx, agent, action) {
      const a = action as Extract<Action, { type: 'wechat' }>;
      if (!ctx.features.wechat) return fail(ctx, agent, '这里没有微信');
      const who = findAgent(ctx.agents, a.to, agent);
      if (!who) return fail(ctx, agent, `没有叫“${a.to}”的人`);
      agent.stats.whispers++;
      ctx.emit({ kind: 'wechat', t: ctx.now, agentId: agent.config.id, to: who.config.id, text: a.text });
      ctx.wake(who.config.id);
      return 2000 + a.text.length * 40;
    },
    allowedInJail: true,
  },
];

/** 面前（脚下高度或地面高度）那格是不是箱子 */
export function chestInFront(ctx: Pick<ActionContext, 'world'>, agent: AgentState): Vec3 | null {
  for (const t of ['front', 'front_down', 'front_up'] as BlockTarget[]) {
    const c = targetCell(agent, t);
    if (ctx.world.get(c.x, c.y, c.z) === BLOCK.chest) return c;
  }
  return null;
}

export function getHandler(type: string): ActionHandler | undefined {
  return ACTIONS.find((h) => h.type === type);
}

/** 所有动作类型名，给错误提示用 */
export const ACTION_TYPES = () => ACTIONS.map((h) => h.type);

/** 动作说明列表（按本局功能过滤：没开微信的剧本不列微信） */
export function actionDocs(o: DocOpts = DEFAULT_DOC_OPTS): string[] {
  return ACTIONS.filter((h) => !h.when || h.when(o)).map((h) => (typeof h.doc === 'function' ? h.doc(o) : h.doc));
}
