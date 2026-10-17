import { promptPack } from './persona.js';
import type { AgentState, ModelAdapter, ModelSpec, Relation, Usage } from './types.js';

// 记忆与关系：记忆只留摘要（每攒 10 条压一次，核心 200 字、配角 80 字）；对每个人有好感、信任和具体记得的事

/** 短期记忆攒到这么多条就压成摘要（用户定的 8~10 条） */
export const MEMORY_LIMIT = 10;
/** 压缩时留下最近几条不压，保证下一回合【刚发生的事】还有东西 */
const KEEP_RECENT = 3;
const NOTE_LIMIT = 4;
/** 每个人的原话最多留几句 */
const CLAIM_LIMIT = 4;
const CLAIM_SPEAKERS = 8;

export function remember(a: AgentState, line: string) {
  a.memory.push(line);
}

/** 短期记忆是否该压缩了 */
export const needsCompaction = (a: AgentState) => a.memory.length >= MEMORY_LIMIT;

const compacting = new WeakSet<AgentState>();

/** 摘要的字数上限：核心 200、配角 80（用户 2026-10-15 定） */
export const summaryLimit = (a: AgentState) => (a.config.tier === 'core' ? 200 : 80);

/**
 * 压缩：把攒下的短期记忆和旧摘要合成一段新摘要，交给最便宜的模型（温度 0.3）；没有真模型就用规则合并。
 * 有人设卡和模板时用提示词线程的 memory.summarize.md（角色用自己的口吻记，偏见和走样的闲话会留下来，这是故意的）。
 * 失败也不丢事：规则摘要兜底。
 */
export async function compactMemory(a: AgentState, adapter: ModelAdapter | null, maxTokens?: number, onUsage?: (u: Usage) => void, spec?: ModelSpec | null): Promise<void> {
  if (a.memory.length < MEMORY_LIMIT || compacting.has(a)) return;
  compacting.add(a);
  try {
    const recent = a.memory.splice(0, a.memory.length - KEEP_RECENT);
    const old = a.longMemory.join('');
    const maxChars = summaryLimit(a);
    let summary = ruleMerge(old, recent, maxChars);
    if (adapter && adapter.provider !== 'mock') {
      const pack = promptPack();
      const card = a.config.card;
      const useTemplate = !!(pack && card);
      const prompt = useTemplate
        ? pack!.renderer.renderMemorySummary(card!, old, recent.map(stripStamp), maxChars)
        : `你原先记得的：${old || '（无）'}\n\n最近的事：\n${recent.join('\n')}\n\n请把它们合成一段第一人称的回忆，${maxChars} 字以内，保留人名、谁对我做了什么、我答应过什么、听到的重要消息。只输出这段话。`;
      try {
        // 用专门的便宜模型时，请求要带那个模型自己的型号和参数（不能拿角色自己的型号发到另一家）
        const agent = spec ? { ...a.config, provider: spec.provider, model: spec.model, baseUrlEnv: spec.baseUrlEnv, apiKeyEnv: spec.apiKeyEnv, extraBody: spec.extraBody, price: spec.price } : a.config;
        const text = await adapter.decide({
          agent,
          system: useTemplate ? `你就是${a.config.name}。只输出那段话，不要别的。` : `你是「${a.config.name}」的记忆整理员。只输出那段话。`,
          prompt,
          maxTokens: maxTokens ?? Math.ceil(maxChars * 1.6) + 40,
          json: false,
          temperature: 0.3,
          onUsage,
        });
        const t = text.trim().replace(/^["“]|["”]$/g, '');
        if (t) summary = t.slice(0, maxChars + 40);
      } catch {
        /* 用规则摘要 */
      }
    }
    a.longMemory = [summary];
  } finally {
    compacting.delete(a);
  }
}

export const stripStamp = (s: string) => s.replace(/^\[[^\]]*\]\s*/, '');

/** 不花钱的合并：挑出有人名、有对话、有冲突的几条接在旧摘要后面，超长就从头砍（留最新的） */
function ruleMerge(old: string, lines: string[], maxChars: number): string {
  const score = (s: string) => (/说|私聊|偷|抓|给|收到|发生|听说|想起/.test(s) ? 2 : 0) + (/没做成|到达|动身|往.*走/.test(s) ? -1 : 0);
  const picked = lines
    .map((l, i) => ({ l: stripStamp(l), i, s: score(l) }))
    .sort((p, q) => q.s - p.s || p.i - q.i)
    .slice(0, 4)
    .sort((p, q) => p.i - q.i)
    .map((p) => p.l.slice(0, 50));
  const merged = `${old}${old && !/[。；]$/.test(old) ? '。' : ''}${picked.join('；')}`;
  const chars = [...merged];
  return chars.length > maxChars ? chars.slice(chars.length - maxChars).join('') : merged;
}

// —— 关系 ————————————————————————————————————————————————

const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));

export function relationOf(a: AgentState, otherId: string): Relation {
  const r = (a.relations[otherId] ??= { trust: 0, affection: 0, notes: [] });
  if (typeof r.affection !== 'number') r.affection = r.trust; // 旧存档没有好感值
  return r;
}

/**
 * 调整对某人的信任（信不信他的话），好感跟着动一点；顺手记一条具体的事（最多留 NOTE_LIMIT 条，新的顶掉旧的）。
 * 信任往上回升的速度按角色记仇程度和难度打折（a.recovery）。
 */
export function adjustTrust(a: AgentState, otherId: string, delta: number, note?: string) {
  if (otherId === a.config.id) return;
  const r = relationOf(a, otherId);
  const d = delta > 0 ? delta * (a.recovery ?? 1) : delta;
  r.trust = clamp(r.trust + d);
  r.affection = clamp(r.affection + d * 0.6);
  if (note) addNote(r, note);
}

/** 调整好感（喜不喜欢他），信任跟着动一点 */
export function adjustAffection(a: AgentState, otherId: string, delta: number, note?: string) {
  if (otherId === a.config.id) return;
  const r = relationOf(a, otherId);
  const d = delta > 0 ? delta * (a.recovery ?? 1) : delta;
  r.affection = clamp(r.affection + d);
  r.trust = clamp(r.trust + d * 0.3);
  if (note) addNote(r, note);
}

function addNote(r: Relation, note: string) {
  r.notes.push(note.slice(0, 60));
  if (r.notes.length > NOTE_LIMIT) r.notes.splice(0, r.notes.length - NOTE_LIMIT);
}

/** 觉出被某人骗了一次；被同一个人骗两次就进入“不信你”状态（说什么都要找人核实） */
export function noteExposure(a: AgentState, otherId: string) {
  const r = relationOf(a, otherId);
  r.exposed = (r.exposed ?? 0) + 1;
  r.trust = clamp(r.trust - 20);
  if (r.exposed >= 2) r.distrust = true;
}

/** 别人亲口对我说的话，原话保存不压缩，对口供用 */
export function addClaim(a: AgentState, speakerId: string, text: string) {
  if (!text.trim() || speakerId === a.config.id) return;
  const list = (a.claims[speakerId] ??= []);
  list.push(text.trim().slice(0, 80));
  if (list.length > CLAIM_LIMIT) list.splice(0, list.length - CLAIM_LIMIT);
  const speakers = Object.keys(a.claims);
  if (speakers.length > CLAIM_SPEAKERS) delete a.claims[speakers[0]];
}

export function trustWord(trust: number): string {
  if (trust >= 60) return '非常信任';
  if (trust >= 25) return '有好感';
  if (trust > -25) return '一般';
  if (trust > -60) return '有些防备';
  return '极不信任';
}

/** 把好感/信任换成话（和 prompts/tools/render.mjs 的 describeFeeling 一致；有包时用包里的） */
export function describeFeeling(name: string, affection: number, trust: number, distrust = false): string {
  const pack = promptPack();
  if (pack) return pack.renderer.describeFeeling(name, affection, trust, distrust);
  const a = affection >= 60 ? '很亲近' : affection >= 20 ? '有好感' : affection > -20 ? '不冷不热' : affection > -60 ? '有些厌烦' : '恨得牙痒';
  const t = trust >= 60 ? '什么话都肯跟这人说' : trust >= 20 ? '还算信得过' : trust > -20 ? '说不上信不信' : trust > -60 ? '防着这人' : '这人说的话一个字也不信';
  return `对${name}${a}，${t}${distrust ? '；这人骗过你两回，说什么你都要找人核实' : ''}`;
}

/** 给提示词看的关系摘要：只列有过来往的人 */
export function describeRelations(a: AgentState, nameOf: (id: string) => string): string[] {
  return Object.entries(a.relations)
    .filter(([, r]) => r.trust !== 0 || r.notes.length)
    .map(([id, r]) => `${nameOf(id)}：${trustWord(r.trust)}${r.notes.length ? `（${r.notes.slice(-2).join('；')}）` : ''}`);
}

/**
 * 谣言传播（傍晚时跑一次）：
 * 1）把柄：某人知道的“偷东西/偷听被抓”会随机讲给另一个人，传过去的版本会走样一点；
 * 2）人设卡上“知道的别人的事”（known_secrets）：嘴不严（discretion=low）的人五成概率往外说，嘴还算严两成，嘴很严半成。
 * 返回发生了几次传播，便于写进事件日志。
 */
export function spreadRumors(agents: AgentState[], time: string, rnd: () => number = Math.random): { from: AgentState; to: AgentState; line: string }[] {
  const out: { from: AgentState; to: AgentState; line: string }[] = [];
  const nameOf = (id: string) => agents.find((o) => o.config.id === id)?.config.name ?? id;
  for (const teller of agents) {
    if (!teller.alive) continue;
    let told = false;
    for (const [aboutId, rel] of Object.entries(teller.relations)) {
      const gossip = rel.notes.find((n) => /偷|抓|撞见|被我发现/.test(n));
      if (!gossip || rnd() > 0.5) continue;
      const candidates = agents.filter((o) => o !== teller && o.alive && o.config.id !== aboutId && !(o.relations[aboutId]?.notes ?? []).some((n) => n.includes('听说')));
      if (!candidates.length) continue;
      const listener = candidates[Math.floor(rnd() * candidates.length)];
      const about = nameOf(aboutId);
      const twist = rnd() < 0.3 ? '，好像不止一次' : '';
      const line = `听${teller.config.name}说，${about}${gossip.replace(/^我?/, '')}${twist}`;
      adjustTrust(listener, aboutId, -15, `听说${about}${gossip.slice(0, 20)}`);
      out.push({ from: teller, to: listener, line });
      told = true;
      break; // 每人每次最多传一条
    }
    if (told) continue;
    const card = teller.config.card;
    const chance = card?.discretion === 'low' ? 0.5 : card?.discretion === 'high' ? 0.05 : 0.2;
    for (const k of card?.known_secrets ?? []) {
      if (rnd() > chance) continue;
      const key = k.text.slice(0, 8);
      const candidates = agents.filter(
        (o) =>
          o !== teller &&
          o.alive &&
          o.config.id !== k.owner &&
          !(o.relations[k.owner]?.notes ?? []).some((n) => n.includes(key)) &&
          !(o.config.card?.known_secrets ?? []).some((s) => s.text === k.text),
      );
      if (!candidates.length) continue;
      const listener = candidates[Math.floor(rnd() * candidates.length)];
      const owner = nameOf(k.owner);
      const twist = rnd() < 0.3 ? '，说得有鼻子有眼' : '';
      const line = `听${teller.config.name}悄悄说，${k.text.startsWith(owner) ? '' : owner}${k.text}${twist}`;
      adjustTrust(listener, k.owner, -10, `听说${owner}${k.text.slice(0, 20)}`);
      out.push({ from: teller, to: listener, line });
      break;
    }
  }
  return out;
}
