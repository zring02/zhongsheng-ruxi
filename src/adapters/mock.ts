import type { DecideInput, ModelAdapter } from '../types.js';

const LINES = [
  '今天天气真不错！',
  '你们在聊什么呢？',
  '我刚从那边回来，看见点新鲜事。',
  '有人想一起干点什么吗？',
  '我在想这地方以后会变成什么样。',
  '嗨，好久不见！',
  '那边的东西挺多的。',
  '我这儿有点东西，可以换点什么吗？',
];
const REPLIES = ['哈哈，有道理。', '我同意！', '嗯……让我想想。', '真的吗？说来听听。', '好啊，走吧！', '这话可别让别人听见。'];
const WHISPERS = ['我跟你说个事，别告诉别人。', '你有没有觉得最近不太对？', '我信得过你。'];
const EMOTES = ['wave', 'laugh', 'think', 'dance', 'sleep'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/**
 * 不需要任何 key 的假模型：根据观察随机做决定，用来跑通整个框架和看效果。
 * 输出格式与真实模型完全一致（JSON 文本），走同一套解析流程。
 * 没有观察（说书人、记忆压缩这类调用）时返回空对象，由调用方自己兜底。
 */
export class MockAdapter implements ModelAdapter {
  readonly provider = 'mock';
  available() {
    return true;
  }
  async decide({ observation: obs, system, prompt, onUsage }: DecideInput) {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 900)); // 模拟思考延迟
    // 测试成本表用：MOCK_USAGE=deepseek 让假模型按 deepseek 的价格报一份像真的用量（系统提示词算命中缓存）
    if (onUsage && process.env.MOCK_USAGE) {
      const sys = Math.ceil([...(system ?? '')].length * 0.75);
      onUsage({ provider: process.env.MOCK_USAGE, promptTokens: sys + Math.ceil([...(prompt ?? '')].length * 0.75), cachedTokens: sys, completionTokens: 90 });
    }
    if (!obs) return '{}';
    const heardSomething = obs.heard.length > 0 && Math.random() < 0.6;
    const someoneNear = obs.nearby_agents.find((a) => a.distance < 5);
    const adjacent = obs.nearby_agents.find((a) => a.distance <= 2);
    const frontSolid = obs.self.front.feet !== '空气' && obs.self.front.feet !== '基岩' && obs.self.front.feet !== '箱子';
    const frontUpSolid = obs.self.front.head !== '空气' && obs.self.front.head !== '基岩';
    const items = Object.entries(obs.self.inventory).filter(([, n]) => n > 0);
    const r = Math.random();
    let decision: any;
    if (heardSomething) {
      decision = { thought: '有人在说话，回应一下吧。', action: { type: 'say', text: pick(REPLIES) } };
    } else if (adjacent && r < 0.15) {
      decision = { thought: `${adjacent.name}就在跟前，悄悄说两句。`, action: { type: 'whisper', to: adjacent.id, text: pick(WHISPERS) } };
    } else if (adjacent && r < 0.2 && items.length) {
      decision = { thought: `送${adjacent.name}点东西。`, action: { type: 'give', to: adjacent.id, item: items[0][0], count: 1 } };
    } else if (someoneNear && r < 0.24) {
      decision = { thought: `想听听${someoneNear.name}在说什么。`, action: { type: 'eavesdrop', target: someoneNear.id } };
    } else if (someoneNear && r < 0.27) {
      decision = { thought: `趁${someoneNear.name}不注意摸点东西。`, action: { type: 'steal', target: someoneNear.id } };
    } else if (someoneNear && r < 0.4) {
      decision = { thought: `${someoneNear.name}就在旁边，走过去打个招呼。`, action: { type: 'approach', target: someoneNear.id } };
    } else if (someoneNear && r < 0.5) {
      decision = { thought: `和${someoneNear.name}聊两句。`, action: { type: 'say', text: pick(LINES), to: someoneNear.id } };
    } else if (r < 0.65) {
      const dest = pick(obs.landmarks.filter((l) => l.distance > 4));
      decision = { thought: `想去${dest.name}看看。`, action: { type: 'walk_to', target: dest.id } };
    } else if (r < 0.72) {
      decision = { thought: '往前走几步。', action: { type: 'move', steps: 1 + Math.floor(Math.random() * 4) } };
    } else if (r < 0.78) {
      decision = { thought: '转个身看看别处。', action: { type: 'turn', direction: pick(['left', 'right', 'north', 'south', 'east', 'west']) } };
    } else if (r < 0.85 && (frontSolid || frontUpSolid)) {
      decision = { thought: `面前有${frontSolid ? obs.self.front.feet : obs.self.front.head}，挖一下。`, action: { type: 'break_block', target: frontSolid ? 'front' : 'front_up' } };
    } else if (r < 0.85 && (obs.self.inventory.plank ?? 0) > 0) {
      decision = { thought: '放一块木板。', action: { type: 'place_block', block: 'plank', target: 'front' } };
    } else if (r < 0.93) {
      decision = { thought: '心情不错。', action: { type: 'emote', emote: pick(EMOTES) } };
    } else {
      decision = { thought: '发会儿呆。', action: { type: 'idle', seconds: 3 } };
    }
    decision.goal = decision.thought;
    if (heardSomething) decision.because = `刚听到${obs.heard[0].slice(0, 12)}`;
    else if (obs.memory.length && Math.random() < 0.3) decision.because = obs.memory[obs.memory.length - 1].replace(/^\[[^\]]*\]\s*/, '').slice(0, 20);
    return JSON.stringify(decision);
  }
}
