import type { Landmark, Vec3 } from './types.js';

// 方块世界：体素网格、地形生成、站立/台阶规则、寻路

export interface BlockType {
  id: number;
  name: string;
  cn: string;
  color: string;
  solid: boolean;
  breakable: boolean;
}

/** 方块表。id 必须和数组下标一致，前端用同一份数据上色 */
export const BLOCK_TYPES: BlockType[] = [
  { id: 0, name: 'air', cn: '空气', color: '#000000', solid: false, breakable: false },
  { id: 1, name: 'grass', cn: '草方块', color: '#5fa84a', solid: true, breakable: true },
  { id: 2, name: 'dirt', cn: '泥土', color: '#8b5a2b', solid: true, breakable: true },
  { id: 3, name: 'stone', cn: '石头', color: '#8d8d8d', solid: true, breakable: true },
  { id: 4, name: 'wood', cn: '木头', color: '#6b4423', solid: true, breakable: true },
  { id: 5, name: 'leaves', cn: '树叶', color: '#2f7d32', solid: true, breakable: true },
  { id: 6, name: 'plank', cn: '木板', color: '#c8a063', solid: true, breakable: true },
  { id: 7, name: 'sand', cn: '沙子', color: '#e2d29b', solid: true, breakable: true },
  { id: 8, name: 'bedrock', cn: '基岩', color: '#3a3a3a', solid: true, breakable: false },
  { id: 9, name: 'iron_ore', cn: '铁矿', color: '#c49a7a', solid: true, breakable: true },
  { id: 10, name: 'coal_ore', cn: '煤矿', color: '#4a4a4a', solid: true, breakable: true },
  /** 箱子：可以往里放东西/取东西（put / take），挖不掉 */
  { id: 11, name: 'chest', cn: '箱子', color: '#a0622d', solid: true, breakable: false },
];
export const BLOCK: Record<string, number> = Object.fromEntries(BLOCK_TYPES.map((b) => [b.name, b.id]));
export const blockById = (id: number): BlockType => BLOCK_TYPES[id] ?? BLOCK_TYPES[0];
export const blockByName = (name: string): BlockType | undefined => BLOCK_TYPES.find((b) => b.name === name || b.cn === name);

/** 默认地图大小。剧本可以在 world.size 里改（x、z 取 48–160），y 固定 20 */
export const WORLD_SIZE: Vec3 = { x: 80, y: 20, z: 80 };
export const MIN_WORLD_XZ = 48;
export const MAX_WORLD_XZ = 160;
const DIRS: Vec3[] = [
  { x: 0, y: 0, z: -1 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
];

export class VoxelWorld {
  readonly data: Uint8Array;

  constructor(readonly size: Vec3 = WORLD_SIZE) {
    this.data = new Uint8Array(size.x * size.y * size.z);
  }

  inBounds(x: number, y: number, z: number) {
    return x >= 0 && x < this.size.x && y >= 0 && y < this.size.y && z >= 0 && z < this.size.z;
  }

  idx(x: number, y: number, z: number) {
    return (y * this.size.z + z) * this.size.x + x;
  }

  /** 世界顶上是空气；四周边缘和地底当作基岩，角色走不出去 */
  get(x: number, y: number, z: number): number {
    if (y >= this.size.y) return BLOCK.air;
    if (!this.inBounds(x, y, z)) return BLOCK.bedrock;
    return this.data[this.idx(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    this.data[this.idx(x, y, z)] = id;
    return true;
  }

  isSolid(x: number, y: number, z: number) {
    return blockById(this.get(x, y, z)).solid;
  }

  /** 角色 2 格高：脚下要实心，脚和头的位置要是空的 */
  canStand(x: number, y: number, z: number) {
    return this.isSolid(x, y - 1, z) && !this.isSolid(x, y, z) && !this.isSolid(x, y + 1, z);
  }

  /** 某列地表上方第一个可以站脚的 y */
  surfaceY(x: number, z: number) {
    for (let y = this.size.y - 1; y >= 0; y--) if (this.isSolid(x, y, z)) return y + 1;
    return 1;
  }

  /** 从 from 朝 dir 走一步后应站的位置；走不了返回 null。允许上下 1 格台阶 */
  step(from: Vec3, dir: Vec3): Vec3 | null {
    const nx = from.x + dir.x;
    const nz = from.z + dir.z;
    if (nx < 0 || nz < 0 || nx >= this.size.x || nz >= this.size.z) return null;
    for (const dy of [0, 1, -1]) {
      if (dy === 1 && this.isSolid(from.x, from.y + 2, from.z)) continue; // 头顶有东西，爬不上去
      if (dy === -1 && this.isSolid(nx, from.y + 1, nz)) continue; // 下台阶时头还在原高度，目标列头顶高度有悬挑会撞头
      if (this.canStand(nx, from.y + dy, nz)) return { x: nx, y: from.y + dy, z: nz };
    }
    return null;
  }

  /**
   * BFS 寻路，返回不含起点的格子序列。目标列到不了时，退而求其次走到
   * 能到的、离目标最近的格子（最多差 nearEnough 格）；再远就返回 null。
   * isBlocked(p) 为 true 的格子（例如有人站着）当作障碍绕开
   */
  findPath(from: Vec3, goal: { x: number; z: number }, nearEnough = 3, maxNodes = 30000, isBlocked?: (p: Vec3) => boolean): Vec3[] | null {
    const key = (p: Vec3) => this.idx(p.x, p.y, p.z);
    const prev = new Map<number, number>();
    const nodes = new Map<number, Vec3>();
    const queue: Vec3[] = [from];
    nodes.set(key(from), from);
    prev.set(key(from), -1);
    const distTo = (p: Vec3) => Math.max(Math.abs(p.x - goal.x), Math.abs(p.z - goal.z));
    const build = (end: Vec3) => {
      const path: Vec3[] = [];
      for (let k = key(end); k !== key(from); k = prev.get(k)!) path.push(nodes.get(k)!);
      return path.reverse();
    };
    let best = from;
    let head = 0;
    while (head < queue.length && nodes.size < maxNodes) {
      const cur = queue[head++];
      if (cur.x === goal.x && cur.z === goal.z) return build(cur);
      if (distTo(cur) < distTo(best)) best = cur;
      for (const d of DIRS) {
        const n = this.step(cur, d);
        if (!n || isBlocked?.(n)) continue;
        const k = key(n);
        if (nodes.has(k)) continue;
        nodes.set(k, n);
        prev.set(k, key(cur));
        queue.push(n);
      }
    }
    return distTo(best) <= nearEnough ? build(best) : null;
  }

  /** 这一列的地表能不能当落脚点：站在地面上（不是树顶），而且站得下 */
  isGroundSpot(x: number, z: number) {
    const y = this.surfaceY(x, z);
    const under = this.get(x, y - 1, z);
    return this.canStand(x, y, z) && under !== BLOCK.leaves && under !== BLOCK.wood;
  }

  /** 在 (x,z) 附近找一个地面落脚点，由近到远螺旋搜索；ok(x,z) 可以再排除掉一些列（例如有人站着的） */
  findGroundSpot(x: number, z: number, maxR = 6, ok?: (x: number, z: number) => boolean): Vec3 | null {
    for (let r = 0; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = x + dx;
          const cz = z + dz;
          if (cx < 0 || cz < 0 || cx >= this.size.x || cz >= this.size.z) continue;
          if (ok && !ok(cx, cz)) continue;
          if (this.isGroundSpot(cx, cz)) return { x: cx, y: this.surfaceY(cx, cz), z: cz };
        }
      }
    }
    return null;
  }

  toBase64() {
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength).toString('base64');
  }
}

// —— 地形生成 ——————————————————————————————————————————————

/** 地标定义：位置和半径按地图大小的比例给（以 48×48 为基准），想改地图布局就改这里 */
const LANDMARK_DEFS = [
  { id: 'spawn', name: '中心广场', fx: 0.5, fz: 0.5, r: 6, description: '木板铺成的广场，大家的出生点' },
  { id: 'forest', name: '森林', fx: 0.23, fz: 0.25, r: 9, description: '长满树，可以砍木头' },
  { id: 'quarry', name: '采石场', fx: 0.77, fz: 0.23, r: 7, description: '裸露的石头和矿石，可以挖矿' },
  { id: 'sandpit', name: '沙地', fx: 0.25, fz: 0.77, r: 7, description: '低洼的沙地' },
  { id: 'hill', name: '小山', fx: 0.77, fz: 0.77, r: 8, description: '镇子东南的高地，视野好' },
];

interface LandmarkDef {
  id: string;
  name: string;
  x: number;
  z: number;
  r: number;
  description: string;
}

/** 把比例换成这张地图上的格子坐标；半径随地图放大但不超过 1.6 倍，免得整张图都是地标 */
function landmarkDefs(size: Vec3): LandmarkDef[] {
  const k = Math.min(1.6, Math.max(1, Math.min(size.x, size.z) / 48));
  return LANDMARK_DEFS.map((l) => ({ id: l.id, name: l.name, x: Math.round(l.fx * size.x), z: Math.round(l.fz * size.z), r: Math.round(l.r * k), description: l.description }));
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 简单的二维值噪声，返回 0..1 */
function valueNoise(rnd: () => number, grid = 64) {
  const g = Float32Array.from({ length: grid * grid }, () => rnd());
  const at = (a: number, b: number) => g[(((a % grid) + grid) % grid) + (((b % grid) + grid) % grid) * grid];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return (x: number, z: number) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const u = smooth(x - xi);
    const v = smooth(z - zi);
    return lerp(lerp(at(xi, zi), at(xi + 1, zi), u), lerp(at(xi, zi + 1), at(xi + 1, zi + 1), u), v);
  };
}

export function generateWorld(seed = 42, size: Partial<Vec3> = {}): { world: VoxelWorld; landmarks: Landmark[] } {
  const clamp = (v: number | undefined, d: number) => (Number.isFinite(v) ? Math.min(MAX_WORLD_XZ, Math.max(MIN_WORLD_XZ, Math.round(v!))) : d);
  const world = new VoxelWorld({ x: clamp(size.x, WORLD_SIZE.x), y: WORLD_SIZE.y, z: clamp(size.z, WORLD_SIZE.z) });
  const { x: SX, y: SY, z: SZ } = world.size;
  const DEFS = landmarkDefs(world.size);
  const rnd = mulberry32(seed);
  const n1 = valueNoise(rnd);
  const n2 = valueNoise(rnd);
  const region = (x: number, z: number) => DEFS.find((l) => Math.hypot(x - l.x, z - l.z) <= l.r);

  /** 基础噪声地形，再往各地标的目标高度平滑过渡，避免出现走不上去的陡崖 */
  const heightAt = (x: number, z: number) => {
    const base = 6 + n1(x / 10, z / 10) * 4 + n2(x / 4, z / 4) * 1.5;
    let h = base;
    for (const l of DEFS) {
      const d = Math.hypot(x - l.x, z - l.z);
      if (d > l.r) continue;
      const t = Math.min(1, (l.r - d) / 3);
      const target =
        l.id === 'spawn' ? 7 : l.id === 'sandpit' ? 5.5 : l.id === 'quarry' ? Math.max(base, 9.5) : l.id === 'hill' ? Math.max(base, 10) + Math.max(0, 3 - d) * 0.7 : base;
      h += (target - h) * t;
    }
    return Math.max(3, Math.min(13, Math.round(h)));
  };

  for (let x = 0; x < SX; x++) {
    for (let z = 0; z < SZ; z++) {
      const h = heightAt(x, z);
      const reg = region(x, z)?.id;
      for (let y = 0; y <= h; y++) {
        let id: number;
        if (y === 0) id = BLOCK.bedrock;
        else if (y < h - 3) id = BLOCK.stone;
        else if (y < h) id = reg === 'sandpit' ? BLOCK.sand : reg === 'quarry' ? BLOCK.stone : BLOCK.dirt;
        else if (reg === 'spawn' && Math.hypot(x - DEFS[0].x, z - DEFS[0].z) <= 4) id = BLOCK.plank;
        else if (reg === 'sandpit') id = BLOCK.sand;
        else if (reg === 'quarry') id = BLOCK.stone;
        else id = BLOCK.grass;
        if (id === BLOCK.stone) {
          const p = reg === 'quarry' ? (y === h ? 0.12 : 0.06) : 0.012;
          if (rnd() < p) id = rnd() < 0.6 ? BLOCK.coal_ore : BLOCK.iron_ore;
        }
        world.set(x, y, z, id);
      }
    }
  }

  const plantTree = (x: number, z: number) => {
    const h = heightAt(x, z);
    if (world.get(x, h, z) !== BLOCK.grass || h + 6 >= SY) return false;
    for (let y = h + 1; y <= h + 4; y++) world.set(x, y, z, BLOCK.wood);
    for (let dy = 3; dy <= 5; dy++) {
      const r = dy === 5 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
          if (world.get(x + dx, h + dy, z + dz) === BLOCK.air) world.set(x + dx, h + dy, z + dz, BLOCK.leaves);
        }
      }
    }
    return true;
  };
  const forest = DEFS[1];
  const trees: { x: number; z: number }[] = [];
  const area = (SX * SZ) / (48 * 48); // 树的数量随地图面积放大
  const tryPlant = (x: number, z: number) => {
    if (trees.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3)) return;
    if (DEFS.some((l) => Math.abs(l.x - x) <= 2 && Math.abs(l.z - z) <= 2)) return; // 地标中心留空
    if (plantTree(x, z)) trees.push({ x, z });
  };
  const forestTrees = Math.round(14 * Math.min(area, 2.5));
  for (let i = 0; i < forestTrees * 5 && trees.length < forestTrees; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * (forest.r - 1);
    tryPlant(Math.round(forest.x + Math.cos(a) * d), Math.round(forest.z + Math.sin(a) * d));
  }
  const totalTrees = forestTrees + Math.round(6 * area);
  for (let i = 0; i < totalTrees * 4 && trees.length < totalTrees; i++) {
    const x = 2 + Math.floor(rnd() * (SX - 4));
    const z = 2 + Math.floor(rnd() * (SZ - 4));
    const reg = region(x, z)?.id;
    if (reg && reg !== 'hill') continue;
    tryPlant(x, z);
  }

  const landmarks: Landmark[] = DEFS.map((l) => ({
    id: l.id,
    name: l.name,
    pos: world.findGroundSpot(l.x, l.z) ?? { x: l.x, y: world.surfaceY(l.x, l.z), z: l.z },
    radius: l.r,
    description: l.description,
  }));
  return { world, landmarks };
}
