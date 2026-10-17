import { describeRelations } from './memory.js';
import type { AgentState, GamePhase, Landmark, Observation, Vec3 } from './types.js';
import { FACING_CN, FACING_VEC, FACINGS } from './types.js';
import { BLOCK, blockById, blockByName, type VoxelWorld } from './voxel.js';

// 感知层：把角色周围的方块和实体翻译成模型能读的文字 + 结构化数据

const SIGHT = 8; // 四个方向各看多远
const NEAR = 10; // 多远以内算“附近”（夜里减半）
const NOTABLE_SCAN = 6;
/** 值得专门指出的方块，按优先级 */
const NOTABLE = ['chest', 'wood', 'iron_ore', 'coal_ore', 'plank', 'stone', 'sand'];
export const PHASE_CN: Record<GamePhase, string> = { morning: '早上', noon: '中午', evening: '傍晚', night: '夜里' };
/** 白天（早上、中午）：人多眼杂 */
export const isDaytime = (p: GamePhase) => p === 'morning' || p === 'noon';

/** 相对方位（北=0°，东=90°）转成八方位中文 */
export function compass(dx: number, dz: number): string {
  if (dx === 0 && dz === 0) return '原地';
  const a = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(a / 45) % 8] + '方';
}

/** 水平棋盘距离（格） */
export const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function nearestLandmark(landmarks: Landmark[], p: Vec3): Landmark | null {
  let best: Landmark | null = null;
  let bestD = Infinity;
  for (const l of landmarks) {
    const d = Math.hypot(p.x - l.pos.x, p.z - l.pos.z);
    if (d <= l.radius && d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

/** 物品名：方块用方块表里的中文名，剧本物品（玉佩、信）原样 */
export const itemCn = (k: string) => blockByName(k)?.cn ?? k;

export function describeInventory(inv: Record<string, number>): string {
  const items = Object.entries(inv).filter(([, n]) => n > 0);
  return items.length ? items.map(([k, n]) => `${itemCn(k)}×${n}`).join('、') : '空';
}

export interface ObserveEnv {
  time: string;
  day: number;
  phase: GamePhase;
  now: number;
}

export function buildObservation(world: VoxelWorld, landmarks: Landmark[], agents: AgentState[], self: AgentState, heard: string[], env: ObserveEnv): Observation {
  const p = self.pos;
  const cn = (x: number, y: number, z: number) => blockById(world.get(x, y, z)).cn;
  const f = FACING_VEC[self.facing];
  const front = { feet: cn(p.x + f.x, p.y, p.z + f.z), head: cn(p.x + f.x, p.y + 1, p.z + f.z), ground: cn(p.x + f.x, p.y - 1, p.z + f.z) };
  const near = env.phase === 'night' ? NEAR / 2 : NEAR;

  // 四个方向的视线：模拟一步步走过去（和 world.step 同一套规则，允许上下 1 格台阶），
  // 报出第一个走不过去的地方以及原因。这样“可以走上去/挡住了/悬崖”的判断和 move 的实际结果完全一致
  const fi = FACINGS.indexOf(self.facing);
  const sight: string[] = [];
  for (const [label, off] of [['前方', 0], ['右边', 1], ['后方', 2], ['左边', 3]] as const) {
    const dir = FACINGS[(fi + off) % 4];
    const v = FACING_VEC[dir];
    const prefix = `${label}（${FACING_CN[dir]}）`;
    let line = `${prefix}${SIGHT} 格内畅通`;
    let cur: Vec3 = p;
    for (let d = 1; d <= SIGHT; d++) {
      const n = world.step(cur, v);
      if (n) {
        cur = n;
        continue;
      }
      // 从 cur 出发走不动了，看看是为什么（判断基准是走到 cur 时的高度，不是出发点的高度）
      const x = cur.x + v.x;
      const z = cur.z + v.z;
      const feet = world.isSolid(x, cur.y, z);
      const head = world.isSolid(x, cur.y + 1, z);
      const where = d === 1 ? '你' : '那儿';
      if (feet && head) {
        line = `${prefix}${d} 格处有${cn(x, cur.y, z)}，挡住了路`;
      } else if (feet) {
        const name = cn(x, cur.y, z);
        if (world.isSolid(x, cur.y + 2, z)) line = `${prefix}${d} 格处有${name}（1 格高，但上面有东西，过不去）`;
        else if (world.isSolid(cur.x, cur.y + 2, cur.z)) line = `${prefix}${d} 格处有${name}（1 格高的台阶，但${where}头顶有${cn(cur.x, cur.y + 2, cur.z)}，先挖掉头顶才能上去）`;
        else line = `${prefix}${d} 格处有${name}，过不去`;
      } else if (head) {
        line = `${prefix}${d} 格处有${cn(x, cur.y + 1, z)}（在头顶高度，会撞头）`;
      } else if (!world.isSolid(x, cur.y - 1, z)) {
        let depth = 0;
        while (cur.y - 1 - depth >= 0 && !world.isSolid(x, cur.y - 1 - depth, z)) depth++;
        line = `${prefix}${d} 格处是 ${depth} 格深的悬崖`;
      } else {
        line = `${prefix}${d} 格处过不去`;
      }
      break;
    }
    if (line.endsWith('畅通') && cur.y !== p.y) line += cur.y > p.y ? '（缓坡向上）' : '（缓坡向下）';
    sight.push(line);
  }

  const nearby = agents
    .filter((o) => o !== self && o.alive && cheb(o.pos, p) <= near && Math.abs(o.pos.y - p.y) <= 4)
    .map((o) => ({
      id: o.config.id,
      name: o.config.name,
      direction: compass(o.pos.x - p.x, o.pos.z - p.z),
      distance: cheb(o.pos, p),
      position: o.pos,
      emote: o.emote,
      trust: self.relations[o.config.id]?.trust ?? 0,
      state: o.jailedUntil > env.now ? '被关着' : o.path.length ? '正在走路' : o.thinking ? '正在思考' : o.emote ? `正在${o.emote}` : '站着',
    }))
    .sort((a, b) => a.distance - b.distance);

  // 附近值得注意的方块：每种只报最近的一个，且必须露在外面能看见
  const exposed = (x: number, y: number, z: number) =>
    !world.isSolid(x + 1, y, z) || !world.isSolid(x - 1, y, z) || !world.isSolid(x, y + 1, z) || !world.isSolid(x, y - 1, z) || !world.isSolid(x, y, z + 1) || !world.isSolid(x, y, z - 1);
  const notable: Observation['notable_blocks'] = [];
  for (const name of NOTABLE) {
    const id = BLOCK[name];
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (let dx = -NOTABLE_SCAN; dx <= NOTABLE_SCAN; dx++) {
      for (let dz = -NOTABLE_SCAN; dz <= NOTABLE_SCAN; dz++) {
        for (let dy = -3; dy <= 5; dy++) {
          const x = p.x + dx;
          const y = p.y + dy;
          const z = p.z + dz;
          if (world.get(x, y, z) !== id || !exposed(x, y, z)) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dz)) + Math.abs(dy) * 0.1;
          if (d < bestD) {
            bestD = d;
            best = { x, y, z };
          }
        }
      }
    }
    if (best) notable.push({ block: blockById(id).cn, direction: compass(best.x - p.x, best.z - p.z), distance: cheb(best, p), position: best });
  }

  const lm = landmarks.map((l) => ({ id: l.id, name: l.name, direction: compass(l.pos.x - p.x, l.pos.z - p.z), distance: cheb(l.pos, p) }));
  const here = nearestLandmark(landmarks, p);
  const jailed = self.jailedUntil > env.now;

  const scene = [
    `现在是第 ${env.day} 天，${PHASE_CN[env.phase]}，${env.time}。${jailed ? `你被关着，还要 ${Math.ceil((self.jailedUntil - env.now) / 1000)} 秒才放出来，只能说话、发呆。` : ''}`,
    `你站在坐标 (${p.x}, ${p.y}, ${p.z})${here ? `，在${here.name}` : ''}，脚下是${cn(p.x, p.y - 1, p.z)}，面朝${FACING_CN[self.facing]}。身上：${describeInventory(self.inventory)}。`,
    self.goal ? `你之前的打算：${self.goal}` : '',
    self.lastResult ? `上一步的结果：${self.lastResult}` : '',
    `面前脚下高度是${front.feet}，面前头顶高度是${front.head}，面前的地面是${front.ground}。`,
    ...sight.map((s) => `- ${s}`),
    nearby.length ? `附近的人：${nearby.map((a) => `${a.name}(${a.id}) 在${a.direction} ${a.distance} 格外，${a.state}`).join('；')}。` : '附近没有人。',
    notable.length ? `附近能看到的方块：${notable.map((b) => `${b.block}在${b.direction} ${b.distance} 格 (${b.position.x},${b.position.y},${b.position.z})`).join('；')}。` : '',
    `地标：${lm.map((l) => `${l.name}(${l.id}) 在${l.direction} ${l.distance} 格${here?.id === l.id ? '，你就在这里' : ''}`).join('；')}。`,
    self.eavesdropping && self.eavesdropUntil > env.now ? `你正在偷听 ${agents.find((o) => o.config.id === self.eavesdropping)?.config.name ?? self.eavesdropping}。` : '',
    heard.length ? `你刚听到：${heard.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    time: env.time,
    day: env.day,
    phase: env.phase,
    self: {
      id: self.config.id,
      name: self.config.name,
      position: p,
      facing: self.facing,
      standing_on: cn(p.x, p.y - 1, p.z),
      front,
      inventory: self.inventory,
      moving_to: self.targetName,
      goal: self.goal,
      last_result: self.lastResult,
      wish: self.wish,
    },
    scene,
    nearby_agents: nearby.map(({ state: _s, ...a }) => a),
    notable_blocks: notable,
    landmarks: lm,
    heard,
    memory: self.memory.slice(-10),
    long_memory: self.longMemory,
    relations: describeRelations(self, (id) => agents.find((o) => o.config.id === id)?.config.name ?? id),
  };
}
