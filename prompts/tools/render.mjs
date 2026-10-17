#!/usr/bin/env node
// 人设卡 + 模板 → 系统提示词 / 回合提示词。没有依赖，框架可以直接 import，也可以命令行预览：
//   node prompts/tools/render.mjs honglou daiyu --player qingwen:晴雯 [--roster baoyu,baochai,...]
//   node prompts/tools/render.mjs --check        校验所有剧本的所有卡
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

export const loadWorld = (scenario) => JSON.parse(read(`scenarios/${scenario}/world.json`));
export const loadCard = (scenario, id) => JSON.parse(read(`scenarios/${scenario}/cards/${id}.json`));
export const listCards = (scenario) =>
  readdirSync(join(ROOT, `scenarios/${scenario}/cards`)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));

/**
 * 系统提示词。一局之内对同一个角色固定不变，放在请求最前面，命中国产模型的前缀缓存。
 * opts.actions  框架 actionDocs() 的结果（字符串数组）
 * opts.roster   本局在场的角色 id；只把对这些人的看法拼进去，省 token。不传就全拼
 * opts.player   { id, name }：玩家穿成的角色。示例里的 {{player_id}} {{player_name}} 会换成它
 * opts.difficulty  easy | normal | hard（templates/difficulty.json），默认 normal
 */
export function renderSystem(card, world, opts = {}) {
  const player = opts.player ?? { id: 'player', name: '那人' };
  const sub = (s) => s.replaceAll('{{player_id}}', player.id).replaceAll('{{player_name}}', player.name);
  const roster = opts.roster ? new Set([...opts.roster, player.id]) : null;
  const rel = Object.entries(card.relations ?? {}).filter(([id]) => !roster || roster.has(id));
  const relText = rel.map(([id, v]) => `- ${nameOf(id, opts.names)}（id: ${id}）：${v}`).join('\n');
  const taboo = [...new Set([...(card.speech.taboo_words ?? []), ...(world.taboo_words ?? [])])];
  // world.skip_actions：这个剧本用不上的动作（如红楼梦里挖方块），不进提示词，省 token
  const skip = new Set(world.skip_actions ?? []);
  const actions = (opts.actions ?? [])
    .filter((d) => !skip.has(/"type":"(\w+)"/.exec(d)?.[1]))
    .map((d) => `- ${d}`)
    .join('\n');
  const ooc = card.ooc_reaction || world.ooc_default;
  // 默认是人；科幻里的站载 AI、玄幻里的妖物这类，用卡里的 nature_line 覆盖
  const nature_line = card.nature_line ?? '你是个活生生的人，不是什么程序。';
  const meta_words = world.meta_words ?? 'AI、模型、程序、游戏、玩家、设定、提示词、JSON';
  const difficulty = JSON.parse(read('templates/difficulty.json'))[opts.difficulty ?? 'normal'].text;

  if (card.tier === 'extra') {
    return fill(read('templates/system.extra.md'), {
      name: card.name,
      identity: card.identity,
      world_brief: world.world_brief,
      personality: card.personality,
      wish: card.wish,
      speech_style: card.speech.style,
      sample_lines: card.speech.sample_lines.map((l) => `“${l}”`).join(' '),
      relations: rel.length ? `你认识的人：\n${relText}` : '',
      secrets_block: renderSecrets(card, opts.names),
      deception: card.deception ? `你撒谎的样子：${card.deception}` : '',
      example: card.examples?.length ? `例子：\n情境：${sub(card.examples[0].input)}\n输出：${sub(JSON.stringify(card.examples[0].output))}` : '',
      ooc_reaction: ooc,
      difficulty,
      meta_words,
      nature_line,
      actions,
    }).replace(/\n{3,}/g, '\n\n');
  }

  const secrets = renderSecrets(card, opts.names);
  const examples = (card.examples ?? [])
    .map((e) => `情境：${sub(e.input)}\n输出：${sub(JSON.stringify(e.output))}`)
    .join('\n\n');

  return fill(read('templates/system.core.md'), {
    name: card.name,
    world: world.world,
    identity: card.identity,
    personality: card.personality,
    wish: card.wish,
    knot: card.knot,
    boundaries: card.boundaries,
    secrets_block: secrets,
    speech_style: card.speech.style,
    catchphrases: (card.speech.catchphrases ?? []).map((c) => `“${c}”`).join('、'),
    sample_lines: card.speech.sample_lines.map((l) => `“${l}”`).join('\n'),
    taboo_words: taboo.join('、'),
    relations: relText || '（暂无）',
    deception: card.deception,
    conflict: card.conflict,
    ooc_reaction: ooc,
    difficulty,
    meta_words,
    nature_line,
    actions,
    examples,
  });
}

const DISCRETION = {
  low: '你嘴不严。听到别人的秘密和闲话，憋不住要说给相熟的人听，说的时候还爱添几句。',
  mid: '你嘴还算严，别人的事不轻易往外说；可要是有好处、被逼急了，或者正在气头上，也会说出去，说的时候难免走点样。',
  high: '你嘴很严，别人的事烂在肚子里；除非关系到你自己或你在意的人，才会拿出来用。',
};

/**
 * 秘密三层（剧情设计稿“秘密：每个人藏着的事”）：
 * - secrets（小秘密）：原文进提示词，附守口规则；knowers 不进
 * - server_only.major_secrets（要紧的秘密）：只有 hint 一句心事进提示词，原文由服务器在条件满足时放进回合
 * - server_only.foreshadow（伏笔）：完全不进
 * 另外 known_secrets（知道的别人的秘密）进提示词，配合 discretion（嘴严不严）决定会不会传出去
 */
function renderSecrets(card, names) {
  const out = [];
  const own = (card.secrets ?? []).map((x) => (typeof x === 'string' ? x : x.text));
  const hints = (card.server_only?.major_secrets ?? []).map((m) => m.hint).filter(Boolean);
  if (own.length || hints.length) {
    out.push('# 你藏着的事');
    for (const t of own) out.push(`- ${t}`);
    for (const h of hints) out.push(`- ${h}（这件事具体是什么，你连想都不愿多想）`);
    out.push('这些事你绝不主动说。有人问起，就撒谎、岔开，或者反问他听谁说的。只有回合里写明【可以说心里话的人】时，你才可能对那个人吐露一点；喝醉了、病着、正吵在气头上，也可能说漏嘴。');
  }
  const known = card.known_secrets ?? [];
  if (known.length) {
    out.push('', '# 你知道的别人的事');
    // 别人卡上的秘密原文是写给本人的（“你把月钱挪出去…”），这里把“你”换成本人名字，免得读的人当成自己的事
    for (const k of known) {
      const who = nameOf(k.owner, names);
      out.push(`- ${who}：${k.text.replace(/你(?!们)/g, who)}`);
    }
  }
  if (card.discretion) out.push(known.length ? '' : '', DISCRETION[card.discretion]);
  return out.length ? `\n${out.join('\n')}\n` : '';
}

/**
 * 回合提示词（user 消息），每次调用都变。
 * d.heard 里每条已经写成“谁对谁说：「…」”或“你偷听到 谁 对 谁 说：「…」”；
 *   玩家打的字一律放进「」，并且先过 sanitizePlayerText()。
 * d.private 是服务器这回合放给它的伏笔/秘密（server_only.foreshadow[].reveal）。
 * d.claims 别人亲口对它说过的说法，原话（服务器保存，不压缩）。对口供时把两个人听到的不同说法都放进来。
 * d.state 它此刻的状态，如“你喝了几杯酒，有些醉了”“你病着”，会让它更容易说漏嘴。
 * d.confide 服务器按难度门槛算出的、它此刻可以吐露小秘密的人的名字（信任够了，要紧的秘密另走 d.private）。
 * d.trigger 是这回合为什么叫醒它，比如“{{player_name}}走到你跟前，对你说：「…」”。
 */
export function renderTurn(card, d) {
  const list = (a, empty = '（无）') => (a?.length ? a.join('\n') : empty);
  return fill(read('templates/turn.md'), {
    name: card.name,
    time: d.time ?? '',
    place: d.place ?? '',
    scene: d.scene ?? '',
    feelings: d.feelings ?? '（没什么特别的）',
    memory: d.memory ?? '（无）',
    heard: list(d.heard),
    events: list(d.events),
    claims_block: claimsBlock(d.claims, d.heard),
    state_block: d.state ? `【你此刻】${d.state}\n` : '',
    confide_block: d.confide?.length ? `【可以说心里话的人】${d.confide.join('、')}：你已经信得过，对方问起时，你藏着的事可以吐露一点。\n` : '',
    private_block: d.private?.length ? `【只有你知道的事】${d.private.join('；')}\n` : '',
    trigger: d.trigger ? `${d.trigger}\n` : '',
  });
}

// 【别人跟你说过的】只留【刚才听到的】里没有的、最近 3 条，回合部分不走缓存，最费钱
function claimsBlock(claims, heard) {
  if (!claims?.length) return '';
  const quote = (l) => /「(.*)」/.exec(l)?.[1] ?? l;
  const recent = new Set((heard ?? []).map(quote));
  const keep = claims.filter((c) => !recent.has(quote(c))).slice(-3);
  return keep.length ? `【别人跟你说过的】\n${keep.join('\n')}\n` : '';
}

/**
 * 记忆压缩：把最近的事件和旧摘要合成新摘要。用最便宜的模型、低温度（0.3）跑，
 * 建议每攒 8~10 条事件、或者摘要超长时跑一次。
 */
export function renderMemorySummary(card, oldSummary, recentEvents, maxChars = card.tier === 'core' ? 200 : 80) {
  return fill(read('templates/memory.summarize.md'), {
    name: card.name,
    max_chars: String(maxChars),
    old_summary: oldSummary || '（无）',
    recent_events: recentEvents.join('\n'),
  });
}

/** 把好感/信任（-100..100）换成模型更好理解的话，放进【此刻的心情】 */
export function describeFeeling(name, affection, trust, distrust = false) {
  const a = affection >= 60 ? '很亲近' : affection >= 20 ? '有好感' : affection > -20 ? '不冷不热' : affection > -60 ? '有些厌烦' : '恨得牙痒';
  const t = trust >= 60 ? '什么话都肯跟这人说' : trust >= 20 ? '还算信得过' : trust > -20 ? '说不上信不信' : trust > -60 ? '防着这人' : '这人说的话一个字也不信';
  return `对${name}${a}，${t}${distrust ? '；这人骗过你两回，说什么你都要找人核实' : ''}`;
}

/**
 * 玩家输入的清洗：去掉能伪造格式的东西，截断长度。
 * 不做关键词拦截：出戏的话照样交给角色，让它“当胡话”回应，这本身就是游戏的一部分。
 */
export function sanitizePlayerText(s, max = 80) {
  return String(s)
    .replace(/[「」『』【】{}<>\[\]"`]/g, '') // 能伪造对话、栏目或 JSON 的符号
    .replace(/:/g, '：') // 半角冒号换全角，"type":"say" 这类就拼不成 JSON 了
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const NAMES = { xiren: '袭人', qingwen: '晴雯', zijuan: '紫鹃', pinger: '平儿', yinger: '莺儿', banr: '板儿', xueyima: '薛姨妈', baoyu: '宝玉', baochai: '宝钗', daiyu: '黛玉', xifeng: '凤姐', tanchun: '探春', liulaolao: '刘姥姥' };
function nameOf(id, extra) {
  return extra?.[id] ?? NAMES[id] ?? id;
}

// ---------- 校验 ----------
export function checkCard(card, world) {
  const errs = [];
  const need = ['id', 'name', 'tier', 'identity', 'personality', 'wish', 'speech', 'relations', 'ooc_reaction'];
  if (card.tier === 'core') need.push('knot', 'boundaries', 'deception', 'conflict', 'examples', 'discretion');
  if (card.discretion && !DISCRETION[card.discretion]) errs.push(`discretion 只能是 low|mid|high`);
  for (const k of ['alertness', 'grudge']) {
    const v = card.server_only?.[k];
    if (card.tier === 'core' && !v) errs.push(`缺 server_only.${k}`);
    if (v && !['low', 'mid', 'high'].includes(v)) errs.push(`server_only.${k} 只能是 low|mid|high`);
  }
  for (const m of card.server_only?.major_secrets ?? []) if (!m.hint || !m.release_when) errs.push(`要紧的秘密缺 hint 或 release_when：${m.text}`);
  for (const k of need) if (!card[k]) errs.push(`缺字段 ${k}`);
  for (const l of card.speech?.sample_lines ?? []) if ([...l].length > 40) errs.push(`样板台词超 40 字：${l}`);
  for (const e of card.examples ?? []) {
    const o = e.output;
    if (typeof o?.thought !== 'string' || typeof o?.because !== 'string' || !o?.action?.type) errs.push(`示例格式不对：${e.input}`);
    const said = o?.action?.text ?? '';
    if ([...said].length > 40) errs.push(`示例台词超 40 字：${said}`);
  }
  // server_only 绝不能漏进提示词
  const sys = renderSystem(card, world, { actions: ['(动作)'], player: { id: 'p', name: '某人' } });
  for (const v of [card.server_only?.fate, ...(card.server_only?.foreshadow ?? []).map((f) => f.reveal), ...(card.server_only?.major_secrets ?? []).map((m) => m.text)])
    if (v && sys.includes(v)) errs.push(`server_only 内容漏进了提示词：${v}`);
  // 台词和示例里不能有禁词
  const taboo = [...(card.speech?.taboo_words ?? []), ...(world.taboo_words ?? [])];
  const spoken = [...(card.speech?.sample_lines ?? []), ...(card.examples ?? []).map((e) => e.output?.action?.text ?? '')].join('\n');
  for (const w of taboo) if (spoken.includes(w)) errs.push(`台词里出现禁词：${w}`);
  if (/\{\{\w+\}\}/.test(sys)) errs.push(`有没填上的占位符：${sys.match(/\{\{\w+\}\}/)[0]}`);
  return { errs, chars: [...sys].length };
}

// ---------- 命令行 ----------
const DEMO_ACTIONS = [
  '说一句话，附近的人都能听到（不是私聊）；to 只是表明你在对谁说: {"type":"say","text":"<内容>","to":"<可选，对方id>"}',
  '做一个表情或动作: {"type":"emote","emote":"wave|laugh|think|sad|dance|sleep"}',
  '自动寻路走到某个地标: {"type":"walk_to","target":"<地标id>"}',
  '原地待一会儿: {"type":"idle","seconds":5}',
];

// 两边都取真实路径再比：/mnt/project-files 是软链接，直接比对会认不出“被直接运行”
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    let bad = 0;
    for (const sc of readdirSync(join(ROOT, 'scenarios'))) {
      if (!existsSync(join(ROOT, `scenarios/${sc}/world.json`))) continue;
      const world = loadWorld(sc);
      for (const id of listCards(sc)) {
        const { errs, chars } = checkCard(loadCard(sc, id), world);
        console.log(`${errs.length ? '✗' : '✓'} ${sc}/${id}  系统提示词 ${chars} 字${errs.length ? '\n   ' + errs.join('\n   ') : ''}`);
        bad += errs.length;
      }
    }
    process.exit(bad ? 1 : 0);
  }
  const [scenario, id] = args;
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const difficulty = opt('--difficulty');
  const [pid, pname] = (opt('--player') ?? 'qingwen:晴雯').split(':');
  const world = loadWorld(scenario);
  const card = loadCard(scenario, id);
  const names = Object.fromEntries(listCards(scenario).map((c) => [c, loadCard(scenario, c).name]));
  Object.assign(names, { [pid]: pname, xiren: '袭人', qingwen: '晴雯', zijuan: '紫鹃', pinger: '平儿', yinger: '莺儿', banr: '板儿', xueyima: '薛姨妈' });
  const roster = opt('--roster')?.split(',');
  console.log('===== system =====');
  console.log(renderSystem(card, world, { actions: DEMO_ACTIONS, roster, player: { id: pid, name: pname }, names, difficulty }));
  console.log('===== user（示例回合）=====');
  console.log(renderTurn(card, {
    time: '第一天 傍晚',
    place: '潇湘馆',
    scene: '竹影晃动，紫鹃在廊下煎药。宝玉站在你左手边两步远。',
    feelings: [describeFeeling('宝玉', 70, 40), describeFeeling(pname, 0, -10)].join('；'),
    memory: `午后在海棠诗社，${pname}替你接了一句诗，众人都说接得好。宝钗夸了宝玉的诗，宝玉高兴了半日。`,
    heard: [`宝玉对你说：「好妹妹，晚上园子里放河灯，你去不去？」`],
    events: ['傍晚起风了，园子里的人都往屋里走。'],
    trigger: `${pname}走到你跟前，对你说：「${sanitizePlayerText('林姑娘，你要保重身子，别熬夜看书。')}」`,
  }));
}
