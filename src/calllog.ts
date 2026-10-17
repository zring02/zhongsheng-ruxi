import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { redactSecrets } from './adapters/http.js';
import { parseDecision } from './prompt.js';
import type { DecideInput, ModelAdapter, Usage } from './types.js';

/**
 * 模型调用记录：每次调用（角色决策、说书人、记忆摘要）一条，JSON Lines 落盘。
 * 用途：接真模型时看角色入戏程度、调提示词、对账（token、缓存命中）、数解析失败。
 * 开关：环境变量 CALL_LOG=1（写到 saves/calls/<局id>.jsonl）或 CALL_LOG_DIR=<目录>。
 * 记录里只有提示词和模型输出，没有 key（报错文字里像 key 的串会抹掉）；同一个角色同一种用途的每份系统提示词只写一次全文，之后只写 hash。
 */

export type CallPurpose = 'decide' | 'storyteller' | 'memory';

export interface CallRecord {
  /** 本局第几次调用（从 1 起） */
  n: number;
  /** 墙上时间 ISO */
  t: string;
  /** 距记录开始的毫秒 */
  e: number;
  /** 调用者 id / 名字 / 分档 */
  who: string;
  name: string;
  tier?: 'core' | 'extra';
  purpose: CallPurpose;
  provider: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  json: boolean;
  systemHash: string;
  systemChars: number;
  /** 系统提示词全文：这个角色第一次出现、或系统提示词变了时才写 */
  system?: string;
  prompt: string;
  /** 模型原始输出（出错时为 null） */
  output: string | null;
  error?: string;
  /** 耗时毫秒 */
  ms: number;
  usage?: { promptTokens: number; cachedTokens: number; completionTokens: number };
  /** 角色决策：按模拟器同一套规则解析的结果；说书人：是否抠出 JSON */
  parse?: { ok: boolean; fatal?: boolean; error?: string; action?: string; thought?: string; because?: string; feel?: Record<string, string>; goal?: string };
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

export class CallLog {
  private n = 0;
  private readonly startedAt = Date.now();
  private readonly seenSystem = new Map<string, string>();
  private failed = false;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  get count() {
    return this.n;
  }

  /** 读回全部记录（文件里一行一条） */
  static read(file: string): CallRecord[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as CallRecord;
        } catch {
          return null;
        }
      })
      .filter((x): x is CallRecord => !!x);
  }

  add(rec: Omit<CallRecord, 'n' | 't' | 'e' | 'systemHash' | 'systemChars' | 'system'> & { system: string }) {
    const { system, ...rest } = rec;
    const h = hash(system);
    // 同一个角色的决策和记忆摘要用的是两份系统提示词，分开记；说书人的事件/章回/结局也各一份
    const key = `${rest.who}:${rest.purpose}:${h}`;
    const first = !this.seenSystem.has(key);
    if (first) this.seenSystem.set(key, h);
    const full: CallRecord = { n: ++this.n, t: new Date().toISOString(), e: Date.now() - this.startedAt, ...rest, ...(rest.error ? { error: redactSecrets(rest.error) } : {}), systemHash: h, systemChars: system.length, ...(first ? { system } : {}) };
    if (this.failed) return;
    try {
      appendFileSync(this.file, JSON.stringify(full) + '\n');
    } catch (e) {
      this.failed = true;
      console.warn(`[调用记录] 写 ${this.file} 失败，停止记录：${(e as Error).message}`);
    }
  }
}

function tryJSON(text: string): boolean {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return false;
  try {
    JSON.parse(text.slice(s, e + 1));
    return true;
  } catch {
    return false;
  }
}

/** 判断这次调用是干什么的：说书人（固定 id）、记忆摘要（不要 JSON、低温度）、其余是角色决策 */
export function purposeOf(input: DecideInput): CallPurpose {
  if (input.agent.id === '_storyteller') return 'storyteller';
  if (input.json === false) return 'memory';
  return 'decide';
}

/** 给适配器套一层：每次 decide 都记一条（成功、失败都记），用量照样报给原来的 onUsage */
export function recordingAdapter(inner: ModelAdapter, log: CallLog): ModelAdapter {
  return {
    provider: inner.provider,
    available: (agent) => inner.available(agent),
    async decide(input) {
      const started = Date.now();
      let usage: Usage | undefined;
      const onUsage = (u: Usage) => {
        usage = u;
        input.onUsage?.(u);
      };
      const purpose = purposeOf(input);
      const base = {
        who: input.agent.id,
        name: input.agent.name,
        tier: input.agent.tier,
        purpose,
        provider: inner.provider,
        model: input.agent.model,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        json: input.json !== false,
        system: input.system,
        prompt: input.prompt,
      };
      try {
        const text = await inner.decide({ ...input, onUsage });
        let parse: CallRecord['parse'];
        if (purpose === 'decide') {
          const p = parseDecision(text);
          parse = p.error !== undefined ? { ok: false, fatal: p.fatal, error: p.error, thought: p.thought || undefined } : { ok: true, action: p.decision.action.type, thought: p.decision.thought || undefined, because: p.decision.because, feel: p.decision.feel, goal: p.decision.goal };
        } else if (purpose === 'storyteller') parse = { ok: tryJSON(text) };
        log.add({ ...base, output: text, ms: Date.now() - started, usage: usage ? { promptTokens: usage.promptTokens, cachedTokens: usage.cachedTokens, completionTokens: usage.completionTokens } : undefined, parse });
        return text;
      } catch (err) {
        log.add({ ...base, output: null, error: String((err as Error).message ?? err).slice(0, 300), ms: Date.now() - started, usage: usage ? { promptTokens: usage.promptTokens, cachedTokens: usage.cachedTokens, completionTokens: usage.completionTokens } : undefined });
        throw err;
      }
    },
  };
}
