import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { addLandmarkLabels, Character, removeLabels, VoxelRenderer } from './scene.js';
import { DIFFICULTY_CN, EMOTE_CN, PHASE_CN, renderEventLine } from './events.js';
import { addRecapToEnding, closeStart, hideEnding, initOverlays, isEndingOpen, isStartOpen, openGallery, openStart, showEnding } from './start.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');

// —— Three.js 基础设置 ——
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
// CSS2DRenderer 给每个标签按深度设很大的 z-index；给容器自己一个层级，标签就不会盖住 HUD 和操作面板
labelRenderer.domElement.style.zIndex = '1';
viewport.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9d6f5');
scene.fog = new THREE.Fog('#a9d6f5', 80, 160);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 4;
controls.maxDistance = 140; // setupWorld 里按地图大小重设
controls.enableDamping = true;
// 左键旋转、滚轮缩放、右键/中键平移（贴着地面平移，不是屏幕空间）
controls.screenSpacePanning = false;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.panSpeed = 1.2;

const hemi = new THREE.HemisphereLight('#ffffff', '#557a46', 0.9);
const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(hemi, sun, sun.target);

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const SKY = { day: new THREE.Color('#a9d6f5'), evening: new THREE.Color('#e9a06a'), night: new THREE.Color('#0d1530') };
/**
 * 根据游戏内时间 + 阶段调整天色：时间决定太阳高度，阶段决定色调。
 * 四段：早上 6–12 / 中午 12–17（亮）、傍晚 17–21（橙）、夜里 21–6（暗）
 */
function applyDaylight(time, phase) {
  const [h, m] = (time ?? '12:00').split(':').map(Number);
  const hour = h + m / 60;
  let day = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)); // 6 点日出，18 点日落
  if (phase === 'night') day = Math.min(day, 0.08);
  else if (phase === 'evening') day = Math.min(Math.max(day, 0.25), 0.5);
  else day = Math.max(day, phase === 'noon' ? 0.8 : 0.45); // 早上、中午都要亮
  const k = 0.25 + 0.75 * day;
  sun.intensity = 1.6 * day + 0.05;
  hemi.intensity = 0.35 + 0.6 * day;
  sun.color.set(phase === 'evening' ? '#ffb070' : phase === 'morning' ? '#fff0d6' : '#fff4e0');
  const sky = SKY.night.clone().lerp(SKY.day, k);
  if (phase === 'evening') sky.lerp(SKY.evening, 0.45);
  scene.background = sky;
  scene.fog.color = sky;
}

// —— 状态 ——
const FACING_VEC = { north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 } };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const S = {
  game: { status: 'none' },
  viewer: null,
  wantObserver: false,
  blockTypes: [],
  blockNames: {}, // 英文方块名 → 中文
  blockIdByName: {},
  landmarks: [],
  agents: new Map(),
  characters: new Map(),
  voxels: null,
  landmarkLabels: [],
  paused: false,
  focusId: null,
  follow: true,
  targetId: null,
  talkOnly: false,
  endingShownFor: null,
  lastEventT: 0,
  cost: null, // {usd, budgetUsd, level}
};
const currencyName = () => S.game.currency?.name ?? null;
const myMoney = () => {
  const name = currencyName();
  return name ? (me()?.inventory?.[name] ?? 0) : null;
};
const isObserver = () => S.viewer === null;
const isPlayerActive = () => !!S.viewer && S.game.status === 'running';
const me = () => (S.viewer ? S.agents.get(S.viewer) : null);
const nameOf = (id) => (id === S.viewer ? '你' : S.agents.get(id)?.name ?? id);
const rawNameOf = (id) => S.agents.get(id)?.name ?? id;
const colorOf = (id) => S.agents.get(id)?.color;
const itemName = (k) => S.blockNames[k] ?? k;
const describeInventory = (inv) => {
  const items = Object.entries(inv ?? {}).filter(([, n]) => n > 0);
  return items.length ? items.map(([k, n]) => `${itemName(k)}×${n}`).join(' ') : '空';
};

// —— 提示 ——
function toast(text, cls = '') {
  const t = document.createElement('div');
  t.className = `toast ${cls}`.trim();
  t.textContent = text;
  $('toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 3200);
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

// —— 世界搭建 / 重建 ——
/** 换局：把旧世界（方块、地标、角色）全部拆掉。方块颜色、世界大小都可能随剧本变 */
function resetWorld() {
  S.voxels?.dispose();
  S.voxels = null;
  removeLabels(scene, S.landmarkLabels);
  S.landmarkLabels = [];
  for (const c of S.characters.values()) c.dispose();
  S.characters.clear();
  S.agents.clear();
  agentRows.clear();
  $('agents').innerHTML = '';
  $('log').innerHTML = '';
  $('chapters').innerHTML = '';
  S.targetId = null;
  S.focusId = null;
  S.lastEventT = 0;
  S.worldSize = null;
  panKeys.clear();
  clearTimeout(dialogueTimer);
  $('dialogue').classList.add('hidden');
  closePopover();
}

function setupWorld(msg) {
  const { size } = msg.world;
  S.blockTypes = msg.blockTypes;
  S.blockNames = {};
  S.blockIdByName = {};
  for (const t of msg.blockTypes) {
    S.blockNames[t.name] = t.cn;
    S.blockIdByName[t.name] = t.id;
  }
  S.landmarks = msg.landmarks;
  S.worldSize = size;
  S.voxels = new VoxelRenderer(scene, size, msg.blockTypes);
  S.voxels.load(msg.world.data);
  S.landmarkLabels = addLandmarkLabels(scene, msg.landmarks);
  // 镜头、雾、阴影范围都按地图大小推：地图可能是 48 也可能是 160
  const span = Math.max(size.x, size.z);
  const cx = size.x / 2;
  const cz = size.z / 2;
  const ground = size.y * 0.35;
  camera.position.set(cx, span * 0.7, cz + span * 0.9);
  controls.target.set(cx, ground, cz);
  controls.minDistance = 4;
  controls.maxDistance = span * 2.2;
  camera.far = Math.max(500, span * 6);
  camera.updateProjectionMatrix();
  scene.fog.near = span * 1.6;
  scene.fog.far = span * 3.4;
  sun.position.set(cx + span * 0.4, span * 1.05, cz + span * 0.2);
  sun.target.position.set(cx, 0, cz);
  const r = span * 0.8;
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: span * 3 });
  sun.shadow.camera.updateProjectionMatrix();
  renderLandmarkButtons();
}

/** 镜头平移后把注视点夹回地图范围内（镜头跟着平移同样的量，视角不变） */
function clampCameraToWorld() {
  const size = S.worldSize;
  if (!size) return;
  const t = controls.target;
  const nx = Math.min(size.x, Math.max(0, t.x));
  const nz = Math.min(size.z, Math.max(0, t.z));
  if (nx !== t.x || nz !== t.z) {
    camera.position.x += nx - t.x;
    camera.position.z += nz - t.z;
    t.x = nx;
    t.z = nz;
  }
}

/** 键盘平移：按住 WASD/方向键（玩家视角下要加 Shift，不然那是走路） */
const panKeys = new Set();
const PAN_KEY = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r' };
function panByKeys(dt) {
  if (!panKeys.size || !S.worldSize) return;
  const span = Math.max(S.worldSize.x, S.worldSize.z);
  const speed = span * 0.35 * dt;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return;
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const d = new THREE.Vector3();
  if (panKeys.has('f')) d.add(fwd);
  if (panKeys.has('b')) d.sub(fwd);
  if (panKeys.has('r')) d.add(right);
  if (panKeys.has('l')) d.sub(right);
  if (d.lengthSq() === 0) return;
  d.normalize().multiplyScalar(speed);
  controls.target.add(d);
  camera.position.add(d);
}

/** 用户主动平移镜头 → 不再跟随，直到按「回到我身边 / 跟随镜头」 */
function breakFollow() {
  if (!S.follow) return;
  S.follow = false;
  renderHud();
  renderAgentList();
}

// —— HUD ——
function renderHud() {
  const g = S.game;
  const hasGame = g.status !== 'none';
  $('hud').classList.toggle('hidden', !hasGame);
  if (!hasGame) {
    $('panel-sub').textContent = '还没开局';
    return;
  }
  $('hud-scenario').textContent = g.scenario?.name ?? '';
  $('hud-clock').textContent = `第${g.day}天 · ${PHASE_CN[g.phase] ?? g.phase} · ${g.time ?? '--:--'}`;
  let left;
  if (g.status === 'ended') left = g.ending ? '已结束' : '结局撰写中…';
  else if (g.mode === 'sandbox') left = '沙盒';
  else left = g.minutesLeft != null ? `还剩 ${Math.ceil(g.minutesLeft)} 分` : `共 ${g.totalDays} 天`;
  $('hud-left').textContent = left;
  $('hud-storyteller').textContent = g.storyteller ? `说书人：${g.storyteller}` : '';
  $('btn-pause').textContent = S.paused ? '继续' : '暂停';
  $('btn-pause').disabled = g.status !== 'running';
  $('btn-end').classList.toggle('hidden', g.status !== 'running');
  // 导出是“全貌接口”：有玩家的局进行中服务端返回 403，所以只在结束后或观察局里给按钮
  $('btn-export').classList.toggle('hidden', !(g.mode === 'sandbox' && (g.status === 'ended' || !g.playerId)));
  $('btn-observer').classList.toggle('hidden', !g.playerId);
  $('btn-observer').textContent = isObserver() && g.playerId ? '回到玩家视角' : '观察视角';
  $('btn-follow').textContent = S.viewer ? '回到我身边' : '跟随镜头';
  $('btn-follow').title = S.viewer ? '镜头回到你身上并跟着你走（平移镜头会暂时脱离）' : '镜头跟随在居民列表里选中的人';
  $('btn-follow').classList.toggle('on', S.follow && !!S.focusId);
  const viewerText = g.playerId ? (isObserver() ? '观察者视角（全知）' : `你是 ${rawNameOf(S.viewer)}`) : '观察模式（没有玩家）';
  const diff = g.difficulty ? ` · ${DIFFICULTY_CN[g.difficulty] ?? g.difficulty}` : '';
  $('hud-mode').textContent = `${g.mode === 'sandbox' ? '沙盒' : '剧情'}${diff}`;
  $('panel-sub').textContent = `${g.scenario?.name ?? ''} · ${g.mode === 'sandbox' ? '沙盒' : '剧情'}${diff} · ${viewerText}`;
  $('status-note').classList.toggle('hidden', !(g.status === 'ended' && !g.ending));
  $('status-note').textContent = '故事到此为止，说书人正在写结局……';
  renderCost();
}

const LEVEL_CN = { ok: '预算正常', saving: '预算用了八成，居民们省着想', over: '预算用完，已换成内置假模型' };
/** HUD 里的花费小标签：花到八成变琥珀色，花完变红 */
function renderCost() {
  const c = S.cost;
  const chip = $('hud-cost');
  if (!c || S.game.status === 'none') return chip.classList.add('hidden');
  const budget = c.budgetUsd ?? S.game.cost?.budgetUsd;
  chip.textContent = `花费 $${(c.usd ?? 0).toFixed(2)}${budget ? ` / $${budget}` : ''}`;
  chip.className = `hud-cost ${c.level ?? 'ok'}`;
  chip.title = LEVEL_CN[c.level] ?? '';
}

$('btn-pause').onclick = () => wsSend({ type: 'control', action: S.paused ? 'resume' : 'pause' });
$('btn-follow').onclick = () => {
  if (S.viewer) {
    // 玩家视角：「回到我身边」= 注视点拉回自己并恢复跟随
    S.focusId = S.viewer;
    S.follow = true;
  } else S.follow = !S.follow;
  renderHud();
  renderAgentList();
};
$('btn-observer').onclick = () => {
  S.wantObserver = !(isObserver() && S.game.playerId);
  wsSend({ type: 'hello', observer: S.wantObserver });
};
$('btn-save').onclick = async () => {
  try {
    await post('/api/game/save');
    toast('已存档');
  } catch (err) {
    toast(`存档失败：${err.message}`, 'error');
  }
};
$('btn-end').onclick = async () => {
  if (!confirm('确定提前结束这局？说书人会据此写出结局。')) return;
  $('btn-end').disabled = true;
  try {
    await post('/api/game/end');
  } catch (err) {
    toast(`结束失败：${err.message}`, 'error');
  } finally {
    $('btn-end').disabled = false;
  }
};
$('btn-new').onclick = () => openStart({ canGoBack: S.game.status !== 'none' });

// —— 居民列表 ——
const agentRows = new Map();
function renderAgentList() {
  const observer = isObserver();
  $('agent-count').textContent = S.agents.size ? `(${S.agents.size})` : '';
  for (const a of S.agents.values()) {
    let li = agentRows.get(a.id);
    if (!li) {
      li = document.createElement('li');
      li.innerHTML = `<span class="swatch"></span>
        <div class="agent-main">
          <div class="agent-head"><b class="name"></b> <span class="badges"></span></div>
          <div class="public"></div>
          <div class="meta"></div>
          <div class="where"></div>
          <div class="inv"></div>
          <div class="thought"></div>
          <div class="goal"></div>
          <div class="trust"></div>
        </div>`;
      li.querySelector('.swatch').style.background = a.color;
      li.querySelector('.name').textContent = a.name;
      li.onclick = () => onAgentRowClick(a.id);
      agentRows.set(a.id, li);
      $('agents').appendChild(li);
    }
    li.classList.toggle('focus', a.id === S.focusId && S.follow);
    li.classList.toggle('target', a.id === S.targetId);
    li.classList.toggle('self', a.id === S.viewer);
    li.title = S.viewer ? (a.id === S.viewer ? '这是你' : '点击选为目标') : '点击让镜头跟随';
    const badges = li.querySelector('.badges');
    badges.innerHTML = '';
    const badge = (t, c) => {
      const s = document.createElement('span');
      s.className = `badge ${c ?? ''}`.trim();
      s.textContent = t;
      badges.appendChild(s);
    };
    if (a.kind === 'player') badge(a.id === S.viewer ? '你' : '玩家', 'player');
    if (a.jailed > 0) badge(`被关 ${a.jailed}s`, 'jailed');
    if (a.eavesdropping) badge(`偷听${rawNameOf(a.eavesdropping)}`, 'eaves');
    if (a.thinking) badge('思考中', 'thinking');
    if (!a.alive) badge('不在了', 'dead');
    li.querySelector('.public').textContent = a.public ?? '';
    li.querySelector('.meta').textContent = a.kind === 'ai' ? `${a.providerLabel}${a.model ? ' · ' + a.model : ''}` : '';
    li.querySelector('.where').textContent = `📍 ${a.location ?? `(${a.pos.x},${a.pos.z})`}`;
    li.querySelector('.inv').textContent = `🎒 ${describeInventory(a.inventory)}`;
    const showInner = observer || a.id === S.viewer;
    li.querySelector('.thought').textContent = showInner && a.lastThought ? `💭 ${a.lastThought}` : '';
    li.querySelector('.goal').textContent = showInner && a.goal ? `🎯 ${a.goal}` : '';
    const trust = Object.entries(a.trust ?? {}).filter(([id]) => S.agents.has(id));
    li.querySelector('.trust').textContent = observer && trust.length ? '信任 ' + trust.map(([id, v]) => `${rawNameOf(id)}${v > 0 ? '+' : ''}${v}`).join(' ') : '';
  }
  for (const [id, li] of agentRows) {
    if (!S.agents.has(id)) {
      li.remove();
      agentRows.delete(id);
    }
  }
}

function onAgentRowClick(id) {
  if (S.viewer && S.game.status === 'running') {
    if (id === S.viewer) {
      S.focusId = id;
      S.follow = true;
    } else selectTarget(S.targetId === id ? null : id);
  } else {
    S.focusId = S.focusId === id ? null : id;
    S.follow = !!S.focusId;
  }
  renderHud();
  renderAgentList();
}

// —— 章回 ——
function renderChapters() {
  const ol = $('chapters');
  ol.innerHTML = '';
  const list = S.game.chapters ?? [];
  $('chapter-count').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = '每个游戏日结束，说书人会写一回。';
    ol.appendChild(li);
    return;
  }
  for (const c of list) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = c.title;
    const p = document.createElement('p');
    p.textContent = c.text;
    li.append(b, p);
    ol.appendChild(li);
  }
}
for (const btn of document.querySelectorAll('.sec-toggle')) btn.onclick = () => $(btn.dataset.target).classList.toggle('collapsed');

// —— 动态日志 ——
$('talk-only').onchange = (e) => {
  S.talkOnly = e.target.checked;
  $('log').classList.toggle('talk-only', S.talkOnly);
};
const logCtx = { nameOf, colorOf, itemName, get viewer() { return S.viewer; } };

/** 写一条小镇动态；replay=true 表示回放历史事件（刚连上/重连时），只写日志不弹气泡 */
function logEvent(ev, replay = false) {
  const $log = $('log');
  const li = renderEventLine(ev, logCtx);
  $log.appendChild(li);
  while ($log.children.length > 300) $log.firstChild.remove();
  $log.scrollTop = $log.scrollHeight;
  if (ev.t > S.lastEventT) S.lastEventT = ev.t;

  if (ev.kind === 'chapter') {
    S.game.chapters ??= [];
    if (!S.game.chapters.some((c) => c.day === ev.day && c.title === ev.title)) {
      S.game.chapters.push({ day: ev.day, title: ev.title, text: ev.text });
      S.game.chapters.sort((a, b) => a.day - b.day);
    }
    renderChapters();
    if (!replay) toast(`${ev.title}`, 'gold');
  } else if (ev.kind === 'ending') {
    S.game.ending = { title: ev.title, text: ev.text, epilogues: ev.epilogues ?? [], chain: ev.chain ?? [], reveals: ev.reveals ?? [] };
    S.game.status = 'ended';
    renderHud();
    renderPlayerPanel();
    if (!replay) maybeShowEnding();
  } else if (ev.kind === 'story' && !replay) toast(`说书人：${ev.title}`, 'gold');
  else if (ev.kind === 'notice' && !replay && ev.agentId === S.viewer && /回话了/.test(ev.text)) setAskBusy(false);
  else if (ev.kind === 'fail' && !replay && ev.agentId === S.viewer && /打听|不够/.test(ev.text)) setAskBusy(false);
  else if (ev.kind === 'caught' && !replay && (ev.agentId === S.viewer || ev.target === S.viewer)) toast(ev.agentId === S.viewer ? `你被${nameOf(ev.by)}抓住了！` : `${nameOf(ev.agentId)}对你下手，被抓住了`, 'error');

  if (replay) return;
  // 只有实时推来的发言才弹头顶气泡，几分钟前说过的旧话不该在重连时一起冒出来
  const ms = (t) => 2500 + String(t).length * 120;
  if (ev.kind === 'say') S.characters.get(ev.agentId)?.say(ev.text, ms(ev.text));
  else if (ev.kind === 'whisper') S.characters.get(ev.agentId)?.whisper(ev.text, ms(ev.text));
  showDialogue(ev);
}

// —— 底部对白条：最近一句看得到的 say / whisper / story ——
let dialogueTimer = 0;
function showDialogue(ev) {
  if (!['say', 'whisper', 'story'].includes(ev.kind)) return;
  const box = $('dialogue');
  const isStory = ev.kind === 'story';
  const speakerId = isStory ? 'storyteller' : ev.agentId;
  box.querySelector('.dlg-portrait').dataset.portrait = speakerId;
  const name = box.querySelector('.dlg-name');
  name.textContent = isStory ? '说书人' : rawNameOf(ev.agentId);
  name.style.color = isStory ? '#ffe2a0' : (colorOf(ev.agentId) ?? '#fff');
  const kind = box.querySelector('.dlg-kind');
  kind.textContent = isStory ? ev.title : ev.kind === 'whisper' ? `悄悄对${nameOf(ev.to)}说` : ev.to ? `对${nameOf(ev.to)}说` : '';
  box.querySelector('.dlg-text').textContent = ev.text;
  box.classList.toggle('whisper', ev.kind === 'whisper');
  box.classList.toggle('story', isStory);
  box.classList.remove('hidden', 'fade');
  clearTimeout(dialogueTimer);
  dialogueTimer = setTimeout(() => box.classList.add('fade'), 8000);
}

function maybeShowEnding() {
  const g = S.game;
  if (g.status !== 'ended' || !g.ending) return;
  if (S.endingShownFor === g.id) return;
  S.endingShownFor = g.id;
  const m = me();
  showEnding(g.ending, { chapters: g.chapters ?? [], stats: m?.stats ?? null, playerName: m?.name });
  // 结算素材：你改变了什么、各人对你的看法、分享文案；玩家放过的方块在 3D 里发光
  fetch('/api/game/recap')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
    .then((recap) => {
      if (recap.id && g.id && recap.id !== g.id) return;
      addRecapToEnding(recap);
      const placed = (recap.world?.playerBlocks ?? []).filter((b) => b.op === 'place').map((b) => b.pos);
      S.voxels?.setGlow(placed);
    })
    .catch((err) => console.warn('结算素材加载失败', err));
}

// —— 状态更新 ——
function applyState(msg) {
  if (msg.game) {
    const prev = S.game.status;
    const { cost, ...light } = msg.game; // 轻量 game 里的 cost 只有 {usd,level}，别盖掉摘要里的完整 cost
    Object.assign(S.game, light);
    if (prev !== S.game.status) renderPlayerPanel();
  }
  // 协议写的是 state.cost，服务端目前放在 state.game.cost；两处都认
  const cost = msg.cost ?? msg.game?.cost;
  if (cost) S.cost = { ...(S.cost ?? {}), ...cost };
  S.paused = msg.paused;
  applyDaylight(msg.time, msg.phase);
  const seen = new Set();
  for (const a of msg.agents) {
    seen.add(a.id);
    S.agents.set(a.id, a);
    if (!S.characters.has(a.id)) S.characters.set(a.id, new Character(scene, a));
    S.characters.get(a.id).update(a);
  }
  for (const [id, c] of S.characters) {
    if (!seen.has(id)) {
      c.dispose();
      S.characters.delete(id);
      S.agents.delete(id);
      if (S.targetId === id) selectTarget(null);
    }
  }
  renderHud();
  renderAgentList();
  updatePlayerStatus();
}

function onInit(msg) {
  resetWorld();
  S.game = msg.game ?? { status: 'none' };
  if (S.game.status === 'none') {
    S.viewer = null;
    renderHud();
    renderPlayerPanel();
    renderChapters();
    hideEnding();
    if (!isStartOpen()) openStart({ canGoBack: false });
    return;
  }
  S.viewer = msg.viewer ?? null;
  S.wantObserver = S.viewer === null && !!S.game.playerId;
  S.cost = S.game.cost ? { usd: S.game.cost.usd, budgetUsd: S.game.cost.budgetUsd, level: S.game.cost.level } : null;
  setupWorld(msg);
  applyState(msg);
  for (const ev of msg.events ?? []) logEvent(ev, true);
  // 对白条：开局后一直在底部，先把最近一句放上去（没有就空着）
  $('dialogue').classList.remove('hidden');
  $('dialogue').classList.add('fade');
  const lastLine = [...(msg.events ?? [])].reverse().find((ev) => ['say', 'whisper', 'story'].includes(ev.kind));
  if (lastLine) showDialogue(lastLine);
  renderChapters();
  // 玩家默认第三人称跟随自己；观察者默认自由镜头
  if (S.viewer) {
    S.focusId = S.viewer;
    S.follow = true;
  } else S.follow = false;
  renderHud();
  renderPlayerPanel();
  renderAgentList();
  if (isStartOpen()) closeStart();
  if (S.game.status === 'ended' && S.game.ending) maybeShowEnding();
  else if (isEndingOpen()) hideEnding();
}

// —— WebSocket ——
let ws;
function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('还没连上服务器', 'error');
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${S.wantObserver ? '?observer=1' : ''}`);
  ws.onopen = () => $('conn').classList.remove('off');
  ws.onclose = () => {
    $('conn').classList.add('off');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'init':
        onInit(msg);
        break;
      case 'state':
        if (S.game.status !== 'none') applyState(msg);
        break;
      case 'event':
        if (S.game.status !== 'none') logEvent(msg.event);
        break;
      case 'blocks':
        S.voxels?.apply(msg.changes);
        break;
      case 'reject':
        toast(msg.text, 'reject');
        break;
    }
  };
}

// —— 玩家操作面板 ——
const act = (action) => isPlayerActive() && wsSend({ type: 'player_action', action });

function renderPlayerPanel() {
  const on = isPlayerActive();
  $('player-panel').classList.toggle('hidden', !on);
  if (!on) closePopover();
  // 微信只在 features.wechat 的剧本（现代）里有
  for (const b of document.querySelectorAll('#player-panel [data-act="wechat"]')) b.classList.toggle('hidden', !S.game.features?.wechat);
  const ask = document.querySelector('#player-panel [data-act="ask"]');
  if (ask && S.game.currency) ask.title = `花 ${S.game.currency.askCost} ${S.game.currency.name}托人打听目标对你（或对别人）的看法`;
  renderTarget();
}

function selectTarget(id) {
  if (id === S.viewer) id = null;
  if (S.targetId && S.characters.has(S.targetId)) S.characters.get(S.targetId).setSelected(false);
  S.targetId = id;
  if (id && S.characters.has(id)) S.characters.get(id).setSelected(true);
  renderTarget();
  renderAgentList();
}

function renderTarget() {
  const a = S.targetId ? S.agents.get(S.targetId) : null;
  $('pp-target').textContent = a ? a.name : '点击场景里的人或居民列表选择';
  $('pp-target').classList.toggle('muted', !a);
  $('pp-clear-target').classList.toggle('hidden', !a);
  for (const b of document.querySelectorAll('#player-panel .needs-target')) b.disabled = !a;
  const modeSel = $('pp-mode');
  $('pp-text').placeholder = modeSel.value === 'storyteller' ? '想让故事里出现什么…' : modeSel.value === 'whisper' ? (a ? `悄悄对${a.name}说…` : '先选一个目标') : a ? `对${a.name}说…` : '对附近的人说…';
}
$('pp-clear-target').onclick = () => selectTarget(null);
$('pp-mode').onchange = renderTarget;

$('pp-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('pp-text').value.trim();
  if (!text) return;
  const mode = $('pp-mode').value;
  let ok = false;
  if (mode === 'storyteller') ok = wsSend({ type: 'storyteller_request', text });
  else if (mode === 'whisper') {
    if (!S.targetId) return toast('私聊要先选一个目标', 'reject');
    ok = act({ type: 'whisper', to: S.targetId, text });
  } else ok = act(S.targetId ? { type: 'say', text, to: S.targetId } : { type: 'say', text });
  if (ok) $('pp-text').value = '';
};

function facingChestCell() {
  const m = me();
  if (!m || !S.voxels) return null;
  const d = FACING_VEC[m.facing] ?? FACING_VEC.south;
  const chest = S.blockIdByName.chest;
  for (const dy of [0, -1, 1]) if (S.voxels.get(m.pos.x + d.x, m.pos.y + dy, m.pos.z + d.z) === chest) return { x: m.pos.x + d.x, y: m.pos.y + dy, z: m.pos.z + d.z };
  return null;
}

/** 自己的状态：被关倒计时、偷听中、面前是否有箱子 */
function updatePlayerStatus() {
  if (!isPlayerActive()) return;
  const m = me();
  const parts = [];
  if (m?.jailed > 0) parts.push(`你被关着，还要 ${m.jailed} 秒`);
  if (m?.eavesdropping) parts.push(`你正在偷听${rawNameOf(m.eavesdropping)}`);
  const st = $('pp-status');
  st.textContent = parts.join(' · ');
  st.classList.toggle('hidden', !parts.length);
  st.classList.toggle('jailed', m?.jailed > 0);
  // 游戏币：背包里 key 等于 currency.name 的那件东西
  const money = myMoney();
  const chip = $('pp-money');
  chip.classList.toggle('hidden', money === null);
  if (money !== null) {
    chip.textContent = `${currencyName()} ${money}`;
    chip.title = `你身上的${currencyName()}（打听一次要 ${S.game.currency?.askCost ?? '?'}）`;
  }
  const chest = !!facingChestCell();
  for (const b of document.querySelectorAll('#player-panel .chest-btn')) b.classList.toggle('hidden', !chest);
  // 拆信：只有手里有信时才显示
  const hasLetter = myLetters().length > 0;
  for (const b of document.querySelectorAll('#player-panel [data-act="read"]')) b.classList.toggle('hidden', !hasLetter);
}

function renderLandmarkButtons() {
  const box = $('pp-landmarks');
  box.innerHTML = '';
  for (const l of S.landmarks) {
    const b = document.createElement('button');
    b.className = 'pp-btn small';
    b.textContent = `去${l.name}`;
    b.title = l.description ?? '';
    b.onclick = () => act({ type: 'walk_to', target: l.id });
    box.appendChild(b);
  }
}

const myInventoryItems = (onlyBlocks = false) =>
  Object.entries(me()?.inventory ?? {})
    .filter(([k, n]) => n > 0 && (!onlyBlocks || k in S.blockIdByName))
    .map(([k, n]) => ({ label: `${itemName(k)} ×${n}`, value: k }));
/** 背包里的信：东西名形如「X写给Y的信」「X写给Y的第2封信」 */
const LETTER_RE = /写给.+的(第\d+封)?信$/;
const myLetters = () =>
  Object.entries(me()?.inventory ?? {})
    .filter(([k, n]) => n > 0 && LETTER_RE.test(k))
    .map(([k, n]) => ({ label: n > 1 ? `${k} ×${n}` : k, value: k }));

/** 打听发出去后按钮先忙着，等「回话了」的 notice 到了再放开（最多等 30 秒） */
let askBusyTimer = 0;
function setAskBusy(on) {
  const btn = document.querySelector('#player-panel [data-act="ask"]');
  if (!btn) return;
  clearTimeout(askBusyTimer);
  btn.classList.toggle('busy', on);
  btn.textContent = on ? '打听中…' : '打听';
  if (on) askBusyTimer = setTimeout(() => setAskBusy(false), 30000);
}

/** 除了自己（和 exclude 里的人）之外的所有活着的居民，用作“选谁”弹层 */
const otherPeople = (...exclude) =>
  [...S.agents.values()].filter((a) => a.id !== S.viewer && a.alive !== false && !exclude.includes(a.id)).map((a) => ({ label: a.name, value: a.id }));

document.querySelectorAll('#player-panel [data-act]').forEach((btn) => {
  btn.onclick = () => {
    const t = S.targetId;
    const m = me();
    switch (btn.dataset.act) {
      case 'approach':
        return t && act({ type: 'approach', target: t });
      case 'whisper':
        if (!t) return;
        $('pp-mode').value = 'whisper';
        renderTarget();
        return $('pp-text').focus();
      case 'eavesdrop':
        return t && act({ type: 'eavesdrop', target: t });
      case 'steal':
        return t && act({ type: 'steal', target: t });
      case 'give':
        return t && openPopover(btn, `给${rawNameOf(t)}什么`, myInventoryItems(), (item) => act({ type: 'give', to: t, item, count: 1 }), { empty: '你背包里没有东西' });
      case 'turn-left':
        return act({ type: 'turn', direction: 'left' });
      case 'turn-right':
        return act({ type: 'turn', direction: 'right' });
      case 'turn-back':
        return act({ type: 'turn', direction: OPPOSITE[m?.facing] ?? 'south' });
      case 'move':
        return act({ type: 'move', steps: 1 });
      case 'break':
        return act({ type: 'break_block', target: 'front' });
      case 'place':
        return openPopover(btn, '放哪种方块', myInventoryItems(true), (block) => act({ type: 'place_block', block, target: 'front' }), { empty: '背包里没有方块，先去挖几块' });
      case 'put':
        return openPopover(btn, '往箱子里放', myInventoryItems(), (item) => act({ type: 'put', item, count: 1 }), { empty: '你背包里没有东西' });
      case 'take':
        return openPopover(btn, '从箱子里取', [], (item) => act({ type: 'take', item, count: 1 }), { freeText: '东西名（箱子里有什么，取不到时会告诉你）' });
      case 'emote':
        return openPopover(btn, '做个表情', Object.entries(EMOTE_CN).map(([k, v]) => ({ label: v, value: k })), (emote) => act({ type: 'emote', emote }));
      case 'ask': {
        // 托人打听：花游戏币问 target 对你（或对别人）的看法
        if (!t) return;
        const cur = S.game.currency ?? { name: '钱', askCost: 0 };
        const items = [{ label: '对你的看法', value: '' }, ...otherPeople(t).map((p) => ({ label: `对${p.label}的看法`, value: p.value }))];
        return openPopover(btn, `托人打听${rawNameOf(t)}（花 ${cur.askCost} ${cur.name}，你有 ${myMoney() ?? 0}）`, items, (about) => {
          if (act(about ? { type: 'ask_around', target: t, about } : { type: 'ask_around', target: t })) setAskBusy(true);
        });
      }
      case 'read':
        // 拆信：手里不是写给自己的信，拆开才有 letter 事件
        return openPopover(btn, '拆哪封信', myLetters(), (item) => act({ type: 'read_letter', item }), { empty: '你手里没有信' });
      case 'pass': {
        // 传话：让跟前的 target 把话带给第三个人
        if (!t) return;
        const people = otherPeople(t);
        return openPopover(btn, `让${rawNameOf(t)}把话带给谁`, people, (to) => openPopover(btn, `要${rawNameOf(t)}带给${rawNameOf(to)}的话`, [], (text) => act({ type: 'pass_message', via: t, to, text }), { freeText: '要带的话…', multiline: true }), { empty: '没有别人可以收话' });
      }
      case 'letter':
        // 写信：写好是背包里的一件东西，之后用「给东西 / 箱子放」交出去
        return openPopover(btn, '写信给谁', otherPeople(), (to) => openPopover(btn, `写给${rawNameOf(to)}的信`, [], (text) => act({ type: 'write_letter', to, text }), { freeText: '信的内容…', multiline: true }), { empty: '没有可以写信的人' });
      case 'wechat':
        // 微信：不用在跟前，只有对方收到
        return openPopover(btn, '发微信给谁', t ? [{ label: rawNameOf(t), value: t }, ...otherPeople(t)] : otherPeople(), (to) => openPopover(btn, `发给${rawNameOf(to)}的微信`, [], (text) => act({ type: 'wechat', to, text }), { freeText: '微信内容…', multiline: true }), { empty: '没有可以发微信的人' });
    }
  };
});

// 通用小弹层：列表 / 自由输入
function openPopover(anchor, title, items, onPick, opts = {}) {
  const pop = $('popover');
  pop.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'pop-title';
  h.textContent = title;
  pop.appendChild(h);
  if (items.length) {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = it.label;
      b.onclick = () => {
        closePopover();
        onPick(it.value);
      };
      li.appendChild(b);
      ul.appendChild(li);
    }
    pop.appendChild(ul);
  } else if (!opts.freeText) {
    const p = document.createElement('div');
    p.className = 'muted small';
    p.textContent = opts.empty ?? '没有可选的';
    pop.appendChild(p);
  }
  if (opts.freeText) {
    const form = document.createElement('form');
    if (opts.multiline) form.classList.add('multiline');
    const input = document.createElement(opts.multiline ? 'textarea' : 'input');
    input.placeholder = opts.freeText;
    input.maxLength = opts.multiline ? 300 : 30;
    if (opts.multiline) input.rows = 3;
    const ok = document.createElement('button');
    ok.textContent = '确定';
    form.append(input, ok);
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      closePopover();
      onPick(v);
    };
    // 多行框里 Enter 直接发，Shift+Enter 换行
    if (opts.multiline) input.addEventListener('keydown', (e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), form.requestSubmit()));
    pop.appendChild(form);
    setTimeout(() => input.focus(), 0);
  }
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  setTimeout(() => addEventListener('pointerdown', onDocDown), 0);
}
function onDocDown(e) {
  if (!$('popover').contains(e.target)) closePopover();
}
function closePopover() {
  $('popover').classList.add('hidden');
  removeEventListener('pointerdown', onDocDown);
}

// 键盘：WASD / 方向键。玩家视角下是走路/转身；观察者（或按住 Shift）是平移镜头
addEventListener('keyup', (e) => panKeys.delete(PAN_KEY[e.key.toLowerCase()]));
addEventListener('blur', () => panKeys.clear());
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const panDir = PAN_KEY[e.key.toLowerCase()];
  if (panDir && (!isPlayerActive() || e.shiftKey)) {
    if (S.game.status === 'none') return;
    e.preventDefault();
    panKeys.add(panDir);
    breakFollow();
    return;
  }
  if (!isPlayerActive()) return;
  const m = me();
  const map = {
    w: { type: 'move', steps: 1 },
    ArrowUp: { type: 'move', steps: 1 },
    a: { type: 'turn', direction: 'left' },
    ArrowLeft: { type: 'turn', direction: 'left' },
    d: { type: 'turn', direction: 'right' },
    ArrowRight: { type: 'turn', direction: 'right' },
    s: { type: 'turn', direction: OPPOSITE[m?.facing] ?? 'south' },
    ArrowDown: { type: 'turn', direction: OPPOSITE[m?.facing] ?? 'south' },
  };
  const a = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!a) return;
  e.preventDefault();
  act(a);
});

// 点击场景：点人 = 选目标（观察者则跟随），点地面 = 走过去
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pressAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pressAt = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
  if (e.button === 1 || e.button === 2) breakFollow(); // 右键/中键拖动 = 平移，脱离跟随
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pressAt || pressAt.button !== 0) return;
  const moved = Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y);
  const held = performance.now() - pressAt.t;
  pressAt = null;
  if (moved > 6 || held > 500) return; // 拖动镜头，不是点击
  onSceneClick(e);
});
function onSceneClick(e) {
  if (S.game.status === 'none') return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const groups = [...S.characters.values()].map((c) => c.group);
  const hit = raycaster.intersectObjects(groups, true)[0];
  if (hit) {
    let o = hit.object;
    while (o && !o.userData.id) o = o.parent;
    if (!o) return;
    // 玩家：点谁就选谁为目标（再点一次不取消，取消用 ✕）；观察者：镜头跟随
    if (S.viewer && S.game.status === 'running') {
      if (o.userData.id !== S.viewer) selectTarget(o.userData.id);
      renderHud();
    } else onAgentRowClick(o.userData.id);
    return;
  }
  if (!isPlayerActive() || !S.voxels) return;
  const vh = raycaster.intersectObjects(S.voxels.meshes, false)[0];
  if (!vh) return;
  // 命中点往方块内部挪一点再取整，就是被点的那块；走到它上面那格
  const p = vh.point.clone().addScaledVector(vh.face.normal, -0.05);
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  if (x < 0 || z < 0 || x >= S.voxels.size.x || z >= S.voxels.size.z) return;
  act({ type: 'walk_to', x, z });
}

// —— 弹层 / 开局界面 ——
initOverlays({
  toast,
  onStarted: () => {
    /* 服务器随后会推 init，世界在 onInit 里重建 */
  },
});
$('ending-again').addEventListener('click', () => (S.endingShownFor = S.game.id));

// —— 渲染循环 ——
let last = performance.now();
renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  for (const c of S.characters.values()) c.tick(dt, t);
  if (S.follow && S.focusId && S.characters.has(S.focusId)) {
    const p = S.characters.get(S.focusId).group.position;
    const offset = camera.position.clone().sub(controls.target);
    controls.target.lerp(p, Math.min(1, dt * 3));
    camera.position.copy(controls.target).add(offset);
  }
  panByKeys(dt);
  controls.update();
  clampCameraToWorld();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

connect();
export { openGallery };
