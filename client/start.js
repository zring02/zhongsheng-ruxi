// 开局界面、读档、结局图鉴、结局弹窗。只做 DOM 和 HTTP，不碰 3D 和 WebSocket。
import { ACTIVITY_CN, GENRE_CN } from './events.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmtDate = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS_CN = { running: '进行中', ended: '已结束' };
const MODE_CN = { story: '剧情', sandbox: '沙盒' };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

let hooks = { toast: () => {}, onStarted: () => {} };
export function initOverlays(h) {
  hooks = { ...hooks, ...h };
  bindStart();
  bindEnding();
  $('gallery-close').onclick = closeGallery;
  for (const ov of document.querySelectorAll('.overlay')) ov.addEventListener('click', (e) => e.target === ov && ov.id !== 'start' && ov.classList.add('hidden'));
}

// —— 开局 ————————————————————————————————————————————————

const start = { scenarios: [], scenario: null, mode: 'story', role: 'player', difficulties: [], difficulty: 'normal' };

async function loadDifficulties() {
  try {
    start.difficulties = await api('/api/difficulties');
  } catch {
    start.difficulties = [];
  }
  renderDifficulties();
}

function renderDifficulties() {
  const box = $('difficulty-picker');
  box.innerHTML = '';
  const list = start.difficulties.length ? start.difficulties : [{ id: 'normal', name: '寻常', text: '默认难度' }];
  if (!list.some((d) => d.id === start.difficulty)) start.difficulty = list.some((d) => d.id === 'normal') ? 'normal' : list[0].id;
  for (const d of list) {
    const lab = el('label', 'role-opt' + (d.id === start.difficulty ? ' on' : ''));
    lab.title = d.text ?? '';
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'difficulty';
    radio.value = d.id;
    radio.checked = d.id === start.difficulty;
    radio.onchange = () => {
      start.difficulty = d.id;
      renderDifficulties();
    };
    lab.appendChild(radio);
    const txt = el('div', 'role-opt-text');
    txt.appendChild(el('b', '', d.name));
    txt.appendChild(el('div', 'muted small one-line', d.text ?? ''));
    lab.appendChild(txt);
    box.appendChild(lab);
  }
}

function bindStart() {
  $('start-gallery').onclick = openGallery;
  $('start-back').onclick = closeStart;
  for (const b of $('mode-toggle').querySelectorAll('button')) {
    b.onclick = () => {
      start.mode = b.dataset.mode;
      renderMode();
    };
  }
  $('start-go').onclick = startGame;
}

export async function openStart({ canGoBack = false } = {}) {
  $('start').classList.remove('hidden');
  $('start-back').classList.toggle('hidden', !canGoBack);
  $('start-error').textContent = '';
  $('start-go').disabled = false;
  loadSaves();
  loadDifficulties();
  try {
    start.scenarios = await api('/api/scenarios');
  } catch (err) {
    $('scenario-cards').textContent = `剧本列表加载失败：${err.message}`;
    return;
  }
  if (!start.scenarios.some((s) => s.id === start.scenario?.id)) start.scenario = start.scenarios[0] ?? null;
  renderScenarios();
  renderMode();
  renderRoles();
}

export function closeStart() {
  $('start').classList.add('hidden');
}

export const isStartOpen = () => !$('start').classList.contains('hidden');

function renderScenarios() {
  const box = $('scenario-cards');
  box.innerHTML = '';
  if (!start.scenarios.length) {
    box.appendChild(el('div', 'muted', '没有可用的剧本'));
    return;
  }
  for (const s of start.scenarios) {
    const card = el('button', 'scenario-card' + (s.id === start.scenario?.id ? ' on' : ''));
    card.type = 'button';
    const head = el('div', 'sc-head');
    head.appendChild(el('span', 'sc-genre', GENRE_CN[s.genre] ?? s.genre));
    head.appendChild(el('b', 'sc-name', s.name));
    card.appendChild(head);
    card.appendChild(el('p', 'sc-tagline', s.tagline));
    card.appendChild(el('div', 'sc-meta', `剧情模式 ${s.duration.minutes} 分钟 · ${s.duration.days} 天 · 说书人${ACTIVITY_CN[s.storytellerActivity] ?? ''}`));
    const core = s.roles.filter((r) => r.tier === 'core').slice(0, 6);
    card.appendChild(el('div', 'sc-roles', '核心人物：' + (core.length ? core.map((r) => r.name).join('、') : '—')));
    card.onclick = () => {
      start.scenario = s;
      renderScenarios();
      renderRoles();
      renderMode();
    };
    box.appendChild(card);
  }
}

function renderMode() {
  for (const b of $('mode-toggle').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === start.mode);
  $('sandbox-options').classList.toggle('hidden', start.mode !== 'sandbox');
  const s = start.scenario;
  $('mode-hint').textContent = start.mode === 'story' ? (s ? `限时 ${s.duration.minutes} 分钟、${s.duration.days} 个游戏日（每天早上、中午、傍晚、夜里四段），每天结束有一回章回，时间到了说书人写结局。` : '') : '不限时，可以改设定、调说书人和昼夜流速，随时「结束这局」拿结局。';
  if (s && start.mode === 'sandbox') $('sb-activity').value = s.storytellerActivity ?? 'normal';
}

function renderRoles() {
  const box = $('role-picker');
  box.innerHTML = '';
  const s = start.scenario;
  if (!s) return;
  const options = [
    { id: '', title: '观察', desc: '没有玩家，只看居民们自己过日子（什么都看得到）' },
    { id: 'player', title: `剧本主角：${s.player.name}`, desc: `${s.player.public}${s.player.wish ? ` · 心愿：${s.player.wish}` : ''}` },
    ...s.roles.filter((r) => r.playable).map((r) => ({ id: r.id, title: `扮演 ${r.name}`, desc: `${r.public}（这个角色不再由 AI 演）` })),
  ];
  if (!options.some((o) => o.id === start.role)) start.role = 'player';
  for (const o of options) {
    const lab = el('label', 'role-opt' + (o.id === start.role ? ' on' : ''));
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'role';
    radio.value = o.id;
    radio.checked = o.id === start.role;
    radio.onchange = () => {
      start.role = o.id;
      renderRoles();
    };
    lab.appendChild(radio);
    const txt = el('div');
    txt.appendChild(el('b', '', o.title));
    txt.appendChild(el('div', 'muted small', o.desc));
    lab.appendChild(txt);
    box.appendChild(lab);
  }
  const isPlayer = start.role !== '';
  $('player-fields').classList.toggle('hidden', !isPlayer);
  if (isPlayer) {
    const tpl = start.role === 'player' ? s.player : s.roles.find((r) => r.id === start.role);
    $('player-name').value = tpl?.name ?? '';
    $('player-wish').value = start.role === 'player' ? s.player.wish ?? '' : '';
  }
}

async function startGame() {
  const s = start.scenario;
  if (!s) return;
  const body = { scenarioId: s.id, mode: start.mode, playerRole: start.role || null, difficulty: start.difficulty };
  if (start.role) {
    body.playerName = $('player-name').value.trim() || undefined;
    body.playerWish = $('player-wish').value.trim() || undefined;
  }
  if (start.mode === 'sandbox') {
    body.sandbox = {
      customText: $('sb-text').value.trim() || undefined,
      storytellerActivity: $('sb-activity').value,
      minutesPerSecond: Number($('sb-mps').value) || 1,
      runWhileAway: $('sb-away').checked,
    };
  }
  $('start-error').textContent = '';
  $('start-go').disabled = true;
  try {
    await api('/api/game/new', body);
    closeStart();
    hooks.onStarted();
  } catch (err) {
    $('start-error').textContent = err.message;
  } finally {
    $('start-go').disabled = false;
  }
}

async function loadSaves() {
  const ul = $('saves');
  ul.innerHTML = '';
  let saves;
  try {
    saves = await api('/api/saves');
  } catch (err) {
    ul.appendChild(el('li', 'muted', `读取存档列表失败：${err.message}`));
    return;
  }
  if (!saves.length) {
    ul.appendChild(el('li', 'muted', '还没有存档（每局每 60 秒自动存一次，也可以在 HUD 里手动存档）'));
    return;
  }
  for (const sv of saves) {
    const li = el('li', 'save-row');
    const info = el('div', 'save-info');
    info.appendChild(el('b', '', sv.scenarioName));
    info.appendChild(el('span', 'muted small', ` ${MODE_CN[sv.mode] ?? sv.mode} · ${STATUS_CN[sv.status] ?? sv.status} · 第${sv.days}天${sv.playerName ? ` · 玩家 ${sv.playerName}` : ' · 观察'}`));
    info.appendChild(el('div', 'muted small', `存于 ${fmtDate(sv.savedAt)}`));
    li.appendChild(info);
    const btn = el('button', 'pp-btn', '载入');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/game/load', { file: sv.file });
        closeStart();
        hooks.onStarted();
      } catch (err) {
        hooks.toast(`读档失败：${err.message}`, 'error');
        btn.disabled = false;
      }
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

// —— 结局图鉴 ————————————————————————————————————————————

export async function openGallery() {
  $('gallery').classList.remove('hidden');
  const box = $('gallery-list');
  box.innerHTML = '';
  box.appendChild(el('div', 'muted', '加载中…'));
  let list;
  try {
    list = await api('/api/endings');
  } catch (err) {
    box.textContent = `加载失败：${err.message}`;
    return;
  }
  box.innerHTML = '';
  if (!list.length) {
    box.appendChild(el('div', 'muted', '图鉴还是空的。打完一局，结局就会收进来。'));
    return;
  }
  for (const e of [...list].reverse()) {
    const card = el('details', 'ending-entry');
    const sum = el('summary');
    sum.appendChild(el('b', 'ee-title', e.title));
    sum.appendChild(el('div', 'muted small', `${e.scenarioName} · ${MODE_CN[e.mode] ?? e.mode} · ${e.days ?? '?'} 天 · ${e.playerName ? `玩家 ${e.playerName}` : '观察'} · ${fmtDate(e.at)}`));
    card.appendChild(sum);
    const body = el('div', 'ee-body');
    body.appendChild(el('p', 'ending-text', e.text));
    if (e.chain?.length) body.appendChild(sectionList('蝴蝶效应', e.chain.map((c) => c.text)));
    if (e.reveals?.length) body.appendChild(sectionList('揭晓', e.reveals.map((r) => `${r.title}：${r.text}`)));
    if (e.epilogues?.length) body.appendChild(sectionList('各人结局', e.epilogues.map((p) => `${p.name}：${p.text}`)));
    if (e.chapters?.length) body.appendChild(sectionList('章回', e.chapters.map((c) => `${c.title}：${c.text}`)));
    if (e.stats) body.appendChild(el('div', 'muted small', statsLine(e.stats)));
    card.appendChild(body);
    box.appendChild(card);
  }
}

export function closeGallery() {
  $('gallery').classList.add('hidden');
}

function sectionList(title, lines) {
  const sec = el('section', 'ee-section');
  sec.appendChild(el('h3', '', title));
  const ul = el('ul');
  for (const l of lines) ul.appendChild(el('li', '', l));
  sec.appendChild(ul);
  return sec;
}

const statsLine = (st) => `帮过 ${st.gives ?? 0} 次 · 私聊 ${st.whispers ?? 0} 次 · 说话 ${st.says ?? 0} 次 · 偷 ${st.steals ?? 0} 次 · 被抓 ${st.caught ?? 0} 次`;

// —— 结局弹窗（分幕播放） ——————————————————————————————————

let endingTimers = [];
const clearTimers = () => {
  for (const t of endingTimers) clearTimeout(t);
  endingTimers = [];
};

function bindEnding() {
  $('ending-close').onclick = hideEnding;
  $('ending-skip').onclick = () => {
    clearTimers();
    endingEndsAt = 0;
    for (const n of $('ending-body').querySelectorAll('.staged')) n.classList.add('shown');
    $('ending-skip').classList.add('hidden');
  };
  $('ending-again').onclick = () => {
    hideEnding();
    openStart({ canGoBack: true });
  };
  $('ending-gallery').onclick = openGallery;
}

/**
 * @param ending {title,text,epilogues,chain?,reveals?}
 * @param ctx { chapters:[], stats:null|{...}, playerName }
 * 顺序：结局名 → 蝴蝶效应链逐条浮现 → 揭晓卡 → 各人结局 → 结局卡（章回 + 玩家数据）
 */
export function showEnding(ending, ctx = {}) {
  clearTimers();
  $('ending').classList.remove('hidden');
  $('ending-title').textContent = ending.title ?? '结局';
  const body = $('ending-body');
  body.innerHTML = '';
  const staged = [];
  const stage = (node, delay) => {
    node.classList.add('staged');
    staged.push([node, delay]);
    body.appendChild(node);
  };
  let t = 400;
  stage(el('p', 'ending-text', ending.text ?? ''), t);
  t += 1500;
  if (ending.chain?.length) {
    const sec = el('section', 'ending-chain');
    sec.appendChild(el('h3', '', '蝴蝶效应'));
    const ol = el('ol');
    sec.appendChild(ol);
    stage(sec, t);
    for (const c of ending.chain) {
      t += 1500;
      const li = el('li', 'staged', c.text);
      ol.appendChild(li);
      staged.push([li, t]);
    }
  }
  for (const r of ending.reveals ?? []) {
    t += 1800;
    const card = el('section', 'reveal-card');
    card.appendChild(el('div', 'reveal-kicker', '原来是这样'));
    card.appendChild(el('h3', '', r.title));
    card.appendChild(el('p', '', r.text));
    stage(card, t);
  }
  if (ending.epilogues?.length) {
    t += 1500;
    const sec = el('section', 'epilogues');
    sec.appendChild(el('h3', '', '各人结局'));
    for (const p of ending.epilogues) {
      const row = el('div', 'epilogue');
      row.appendChild(el('b', '', p.name));
      row.appendChild(el('span', '', p.text));
      sec.appendChild(row);
    }
    stage(sec, t);
  }
  t += 1500;
  const card = el('section', 'ending-final');
  card.appendChild(el('h3', '', '结局卡'));
  if (ctx.chapters?.length) {
    const ol = el('ol', 'chapter-list');
    for (const c of ctx.chapters) {
      const li = el('li');
      li.appendChild(el('b', '', c.title));
      li.appendChild(el('div', 'muted small', c.text));
      ol.appendChild(li);
    }
    card.appendChild(ol);
  } else card.appendChild(el('div', 'muted small', '这局还没来得及写章回。'));
  if (ctx.stats) card.appendChild(el('div', 'player-stats', `${ctx.playerName ? ctx.playerName + '：' : ''}${statsLine(ctx.stats)}`));
  stage(card, t);

  $('ending-skip').classList.remove('hidden');
  for (const [node, delay] of staged) endingTimers.push(setTimeout(() => node.classList.add('shown'), delay));
  endingTimers.push(setTimeout(() => $('ending-skip').classList.add('hidden'), t + 100));
  endingEndsAt = performance.now() + t;
}

let endingEndsAt = 0;

/** -100..100 的信任值 → 一个词 */
export const trustWord = (v) => (v >= 60 ? '信任' : v >= 25 ? '有好感' : v > -25 ? '一般' : v > -60 ? '防备' : '敌视');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** 结算素材到了之后追加到结局弹窗末尾：你改变了什么、各人对你的看法、分享文案 */
export function addRecapToEnding(recap) {
  if (!isEndingOpen() || !recap) return;
  const sec = el('section', 'ending-recap staged');
  sec.appendChild(el('h3', '', '你改变了这个世界'));
  const blocks = recap.world?.playerBlocks?.length ?? 0;
  if (recap.player) sec.appendChild(el('p', 'recap-line', `你改变了这个世界：亲手改了 ${blocks} 块方块，牵动了 ${recap.touchedEvents ?? 0} 件事。`));
  else sec.appendChild(el('p', 'recap-line', `这局没有玩家，居民们自己改了 ${recap.world?.changedBlocks ?? 0} 块方块。`));
  if (recap.people?.length && recap.player) {
    const ul = el('ul', 'recap-people');
    for (const person of recap.people) {
      const li = el('li');
      const sw = el('span', 'swatch');
      sw.style.background = person.color ?? '#888';
      li.appendChild(sw);
      li.appendChild(el('b', '', person.name));
      li.appendChild(el('span', `trust-word t-${trustWord(person.trust)}`, `${trustWord(person.trust)}（${person.trust > 0 ? '+' : ''}${person.trust}）`));
      if (person.notes?.length) li.appendChild(el('div', 'muted small', person.notes.slice(-2).join('；')));
      ul.appendChild(li);
    }
    sec.appendChild(ul);
  }
  if (recap.shareText) {
    const row = el('div', 'recap-share');
    const btn = el('button', 'pp-btn', '复制分享文案');
    const pre = el('pre', 'share-text', recap.shareText);
    btn.onclick = async () => {
      const ok = await copyText(recap.shareText);
      btn.textContent = ok ? '已复制' : '复制失败，请手动选择下面的文字';
      setTimeout(() => (btn.textContent = '复制分享文案'), 2000);
    };
    row.append(btn, pre);
    sec.appendChild(row);
  }
  $('ending-body').appendChild(sec);
  const delay = Math.max(50, endingEndsAt - performance.now() + 800);
  endingTimers.push(setTimeout(() => sec.classList.add('shown'), delay));
}

export function hideEnding() {
  clearTimers();
  $('ending').classList.add('hidden');
}

export const isEndingOpen = () => !$('ending').classList.contains('hidden');
