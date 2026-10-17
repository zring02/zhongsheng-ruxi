import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getHandler } from './actions.js';
// config.js 要排在别的模块前面 import：loadEnv() 在这里调用，之后读 models.json / 构造模拟器时才读得到 .env 里的配置
import { loadEnv, ROOT } from './config.js';
import { GameSession } from './game.js';
import { CallLog } from './calllog.js';
import { loadModels } from './models.js';
import { DIFFICULTIES, difficultyDef, isDifficulty, loadPromptPack, sanitizeText } from './persona.js';
import { loadScenarios, summarizeScenario } from './scenario.js';
import { visibleTo } from './simulation.js';
import type { GameOptions } from './types.js';
import { BLOCK_TYPES } from './voxel.js';

loadEnv();
const PORT = Number(process.env.PORT ?? 3000);

// 兜底：前端、WebSocket、模拟器全在一个进程里，任何一个边角异常都不该把整座小镇带崩。只记日志，进程继续跑
process.on('uncaughtException', (err) => console.error('[server] 未捕获的异常:', err));
process.on('unhandledRejection', (err) => console.error('[server] 未处理的 Promise 拒绝:', err));

const catalog = loadModels();
const scenarios = loadScenarios();
// 提示词包：模板和人设卡在 prompts/ 目录（环境变量 PROMPTS_DIR 可指定）；没有就用内置占位提示词
const promptPackLoaded = await loadPromptPack();
let game: GameSession | null = null;

/** 开新局：停掉旧的，把新的接到广播上 */
let attached: Array<() => void> = [];
function attach(g: GameSession) {
  // 旧局可能还在等说书人写结局，把它从广播上摘下来，免得它的 ending 事件混进新局
  for (const off of attached) off();
  attached = [];
  game?.dispose();
  game = g;
  attached.push(g.sim.onEvent((ev) => wss.clients.forEach((ws) => visibleTo(ev, viewerOf(ws)) && send(ws, { type: 'event', event: ev }))));
  attached.push(g.sim.onBlocks((changes) => broadcast({ type: 'blocks', changes })));
  wss.clients.forEach((ws) => {
    // 之前开着观察视角的连接：新局有玩家时按玩家视角发，并告诉前端为什么
    if (viewers.get(ws) === null && observerLocked()) send(ws, { type: 'reject', text: OBSERVER_LOCKED_TEXT });
    sendInit(ws);
  });
  updatePresence();
  console.log(`[game] 开局 ${g.scenario.name}（${g.mode}）`);
  for (const a of g.sim.agents) console.log(`  · ${a.config.name.padEnd(6)} ${a.kind === 'player' ? '玩家' : `${a.config.tier} ${a.providerLabel} ${a.config.model ?? ''}`}`);
}

function parseOptions(body: any): GameOptions {
  if (!body || typeof body !== 'object') throw new Error('缺少开局参数');
  const scenarioId = String(body.scenarioId ?? '');
  if (!scenarios.some((s) => s.id === scenarioId)) throw new Error(`没有叫“${scenarioId}”的剧本`);
  const mode = body.mode === 'sandbox' ? 'sandbox' : 'story';
  const sb = body.sandbox && typeof body.sandbox === 'object' ? body.sandbox : {};
  const mps = Number(sb.minutesPerSecond);
  return {
    scenarioId,
    mode,
    playerRole: typeof body.playerRole === 'string' && body.playerRole ? body.playerRole.slice(0, 40) : null,
    playerName: typeof body.playerName === 'string' ? sanitizeText(body.playerName, 20) || undefined : undefined,
    playerWish: typeof body.playerWish === 'string' ? sanitizeText(body.playerWish, 200) || undefined : undefined,
    seed: Number.isFinite(Number(body.seed)) && body.seed !== '' && body.seed !== null && body.seed !== undefined ? Number(body.seed) : undefined,
    difficulty: isDifficulty(body.difficulty) ? body.difficulty : undefined,
    sandbox:
      mode === 'sandbox'
        ? {
            customText: typeof sb.customText === 'string' ? sb.customText.slice(0, 2000) : undefined,
            extraRoles: Array.isArray(sb.extraRoles) ? sb.extraRoles.slice(0, 12) : undefined,
            removeRoles: Array.isArray(sb.removeRoles) ? sb.removeRoles.filter((x: unknown) => typeof x === 'string').slice(0, 20) : undefined,
            storytellerActivity: ['quiet', 'normal', 'dramatic'].includes(sb.storytellerActivity) ? sb.storytellerActivity : undefined,
            minutesPerSecond: Number.isFinite(mps) && mps > 0 ? Math.min(mps, 60) : undefined,
            disasters: !!sb.disasters,
            runWhileAway: !!sb.runWhileAway,
          }
        : undefined,
  };
}

/** 难度档位（开局界面用）：名字、给角色看的那段话；服务器用的数值不发给前端 */
function difficultyList() {
  return DIFFICULTIES.map((d) => {
    const def = difficultyDef(d);
    return { id: d, name: def.name, text: def.text };
  });
}

// —— HTTP ——
const STATIC_ROOTS: [string, string][] = [
  ['/vendor/three/', resolve(ROOT, 'node_modules/three/')],
  ['/', resolve(ROOT, 'client/')],
];
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<any> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        fail(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', fail);
  });
}

async function api(url: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  try {
    if (url === '/api/scenarios') return json(res, 200, scenarios.map(summarizeScenario)), true;
    if (url === '/api/difficulties') return json(res, 200, difficultyList()), true;
    if (url === '/api/models') {
      return json(res, 200, { tiers: catalog.tiers, maxTokens: catalog.maxTokens, models: Object.fromEntries(Object.entries(catalog.models).map(([k, v]) => [k, { provider: v.provider, model: v.model, label: v.label }])) }), true;
    }
    if (url === '/api/game' && method === 'GET') return json(res, 200, game ? game.summary() : { status: 'none' }), true;
    if (url === '/api/game/new' && method === 'POST') {
      const options = parseOptions(await readBody(req));
      const base = scenarios.find((s) => s.id === options.scenarioId)!;
      const g = new GameSession(base, options, catalog);
      attach(g);
      g.start();
      return json(res, 200, g.summary()), true;
    }
    if (url === '/api/game/end' && method === 'POST') {
      if (!game) return json(res, 400, { error: '没有进行中的游戏' }), true;
      await game.end('提前结束');
      return json(res, 200, game.summary()), true;
    }
    if (url === '/api/game/load' && method === 'POST') {
      const body = await readBody(req);
      const g = GameSession.load(String(body.file ?? ''), catalog);
      attach(g);
      g.resume();
      return json(res, 200, g.summary()), true;
    }
    if (url === '/api/game/save' && method === 'POST') {
      if (!game) return json(res, 400, { error: '没有进行中的游戏' }), true;
      game.save();
      return json(res, 200, { ok: true, id: game.id }), true;
    }
    // 全貌接口（导出、因果、回放、结算素材、调试快照）：有玩家且这局还在进行时不给，免得玩家打开网址就看到秘密
    const FULL_VIEW = ['/api/game/export', '/api/game/causal', '/api/game/replay', '/api/game/recap', '/api/state', '/api/game/calls'];
    if (FULL_VIEW.includes(url) && game && game.playerId && game.status === 'running') return json(res, 403, { error: '这局还在进行中，玩家看不到全貌；结束这局后再看' }), true;
    if (url === '/api/game/export') {
      if (!game) return json(res, 400, { error: '没有进行中的游戏' }), true;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${encodeURIComponent(game.scenario.id)}-sandbox.json"` });
      res.end(JSON.stringify(game.scenario, null, 2));
      return true;
    }
    if (url === '/api/game/causal') return json(res, 200, game?.causal ?? []), true;
    if (url === '/api/game/calls') {
      if (!game) return json(res, 200, { status: 'none' }), true;
      if (!game.callLog) return json(res, 200, { enabled: false, file: null, calls: [] }), true;
      return json(res, 200, { enabled: true, file: basename(game.callLog.file), calls: CallLog.read(game.callLog.file) }), true;
    }
    if (url === '/api/game/cost') return json(res, 200, game ? game.meter.summary() : { status: 'none' }), true;
    if (url === '/api/game/replay') return json(res, 200, game ? game.replay() : { status: 'none' }), true;
    if (url === '/api/game/recap') {
      if (!game) return json(res, 400, { error: '没有进行中的游戏' }), true;
      return json(res, 200, game.recap()), true;
    }
    if (url === '/api/saves') return json(res, 200, GameSession.listSaves()), true;
    if (url === '/api/endings') return json(res, 200, GameSession.listEndings()), true;
    if (url === '/api/state') return json(res, 200, game ? { ...game.sim.snapshot(), game: game.summary(), events: game.sim.events.slice(-50) } : { status: 'none' }), true;
    if (url.startsWith('/api/')) return json(res, 404, { error: 'not found' }), true;
    return false;
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
    return true;
  }
}

const server = createServer(async (req, res) => {
  // 畸形的百分号编码（/%、/%E0%A4%A）会让 decodeURIComponent 抛 URIError，必须接住，否则整个进程退出
  let url: string;
  try {
    url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (await api(url, req, res)) return;
  for (const [prefix, dir] of STATIC_ROOTS) {
    if (!url.startsWith(prefix)) continue;
    let file = normalize(join(dir, url.slice(prefix.length)));
    // 必须落在目录内部（带分隔符边界），不然 client-backup 这类同前缀的兄弟目录也会被放行
    if (file !== dir && !file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) break;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) continue;
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    // 文件在 existsSync 之后被删/没权限等情况下可读流会报错，pipeline 会把错误收住而不是炸掉进程
    pipeline(createReadStream(file), res, (err) => {
      if (err) {
        console.warn(`[server] 读取 ${file} 失败:`, err.message);
        res.destroy();
      }
    });
    return;
  }
  res.writeHead(404).end('not found');
});

// —— WebSocket：推送世界状态和事件，接收玩家动作和控制指令 ——
// 控制消息只有几百字节，maxPayload 收紧一点，防止客户端塞超大帧
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
/** 每条连接是谁的视角：玩家 id（遮住别人的私聊、内心想法）或 null（观察者，全看） */
const viewers = new WeakMap<WebSocket, string | null | 'auto'>();
const viewerOf = (ws: WebSocket): string | null => {
  const v = viewers.get(ws);
  // 观察者视角每次用的时候都重新判断：先开着观察视角、后来才开了有玩家的局，这条连接也得降成玩家视角
  if (v === null) return observerLocked() ? game!.playerId : null;
  return v === 'auto' || v === undefined ? (game?.playerId ?? null) : v;
};
const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
/** 有玩家且这局还在进行中：观察者视角锁住（结束后放开） */
function observerLocked(): boolean {
  return !!(game && game.playerId && game.status === 'running');
}
const OBSERVER_LOCKED_TEXT = '这局有玩家且还在进行中，先按玩家视角看；结束后才能看全貌。';
const broadcast = (msg: unknown) => wss.clients.forEach((ws) => send(ws, msg));

/** 玩家视角的状态：别人的内心想法、打算、信任值都不给看 */
function snapshotFor(viewer: string | null) {
  const snap = game!.sim.snapshot();
  if (viewer === null) return snap;
  return {
    ...snap,
    agents: snap.agents.map((a) => (a.id === viewer ? a : { ...a, lastThought: '', goal: '', trust: {}, affection: {}, wish: '', eavesdropping: null, inventory: {}, stats: { steals: 0, caught: a.stats.caught, gives: 0, whispers: 0, says: a.stats.says } })),
  };
}

function sendInit(ws: WebSocket) {
  if (!game) return send(ws, { type: 'init', game: { status: 'none' }, scenarios: scenarios.map(summarizeScenario), difficulties: difficultyList() });
  const viewer = viewerOf(ws);
  send(ws, {
    type: 'init',
    world: { size: game.sim.world.size, data: game.sim.world.toBase64() },
    blockTypes: BLOCK_TYPES,
    landmarks: game.sim.landmarks,
    events: game.sim.events.filter((ev) => visibleTo(ev, viewer)).slice(-80),
    game: game.summary(),
    viewer,
    ...snapshotFor(viewer),
  });
}

/** 玩家在不在线（沙盒模式下离开就暂停 / 回来讲一段你不在时的事） */
function updatePresence() {
  if (!game?.playerId) return;
  let online = false;
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && viewerOf(ws) === game!.playerId) online = true;
  });
  game.setPlayerOnline(online);
}

wss.on('error', (e) => console.error('[ws] 服务端错误:', e.message));
wss.on('connection', (ws, req) => {
  // 收到非法帧（未掩码、非法 UTF-8、超长）或底层 socket 出错时 ws 会 emit 'error'，
  // 没有监听器就是未捕获异常直接退出进程。记一下就行，库会自己关掉这条连接
  ws.on('error', (e) => console.warn('[ws] 连接错误:', e.message));
  // 有玩家且进行中的局不给观察者视角（和全貌接口一样，不然开个 ?observer=1 就全看到了）；观察局、结束后随意
  const wantObserver = /[?&]observer=1/.test(req.url ?? '');
  // 记下“想看全貌”，真正给不给由 viewerOf 每次判断（局面会变）
  viewers.set(ws, wantObserver ? null : 'auto');
  if (wantObserver && observerLocked()) send(ws, { type: 'reject', text: OBSERVER_LOCKED_TEXT });
  sendInit(ws);
  updatePresence();
  ws.on('close', () => updatePresence());
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (!game) return;
      const sim = game.sim;
      if (msg.type === 'control' && msg.action === 'pause') sim.setPaused(true);
      else if (msg.type === 'control' && msg.action === 'resume') sim.setPaused(false);
      else if (msg.type === 'hello') {
        viewers.set(ws, msg.observer ? null : 'auto');
        if (msg.observer && observerLocked()) send(ws, { type: 'reject', text: OBSERVER_LOCKED_TEXT });
        sendInit(ws);
        updatePresence();
      } else if (msg.type === 'player_action') {
        const pid = game.playerId;
        if (!pid || viewerOf(ws) !== pid || game.status !== 'running') return;
        const handler = getHandler(String(msg.action?.type ?? ''));
        if (!handler) return send(ws, { type: 'reject', text: `不认识的动作 ${msg.action?.type}` });
        const action = handler.parse(msg.action ?? {});
        if (typeof action === 'string') return send(ws, { type: 'reject', text: action });
        sim.enqueue(pid, action, true);
      } else if (msg.type === 'storyteller_request') {
        if (game.status !== 'running') return;
        // 有玩家的局只有玩家本人能点说书人；观察局谁都可以
        if (game.playerId && viewerOf(ws) !== game.playerId) return send(ws, { type: 'reject', text: '只有玩家能对说书人提要求。' });
        const r = game.requestStory(String(msg.text ?? ''), game.playerId ?? undefined);
        send(ws, { type: 'reject', text: r === 'ok' ? '说书人记下了，稍后会把它安排进故事里。' : r === 'busy' ? '说书人手上还有你上一条，过一分钟再说。' : '没听清你想加什么。' });
      }
    } catch {
      /* 忽略非法消息 */
    }
  });
});

setInterval(() => {
  if (!game) return;
  const g = game;
  const light = { status: g.status, day: g.sim.clock.day, phase: g.sim.clock.phase, time: g.sim.clock.time, minutesLeft: g.minutesLeft, totalDays: g.mode === 'story' ? g.scenario.duration.days : null };
  const cost = { usd: Math.round(g.meter.usd * 10000) / 10000, level: g.meter.level };
  wss.clients.forEach((ws) => send(ws, { type: 'state', game: light, cost, ...snapshotFor(viewerOf(ws)) }));
}, 200);

// 启动时若指定了 AUTOSTART_SCENARIO（例如 honglou），直接以观察模式开一局，便于开发时看效果
const auto = process.env.AUTOSTART_SCENARIO;
if (auto && scenarios.some((s) => s.id === auto)) {
  const g = new GameSession(scenarios.find((s) => s.id === auto)!, { scenarioId: auto, mode: process.env.AUTOSTART_MODE === 'sandbox' ? 'sandbox' : 'story', playerRole: process.env.AUTOSTART_PLAYER || null }, catalog);
  attach(g);
  g.start();
}

server.listen(PORT, () => {
  console.log(`AI小镇已启动: http://localhost:${PORT}`);
  console.log(`  剧本: ${scenarios.map((s) => `${s.id}(${s.name})`).join('、')}`);
  if (promptPackLoaded) {
    const withCards = scenarios.filter((s) => promptPackLoaded.hasScenario(s.id)).map((s) => s.id);
    console.log(`  提示词包: ${promptPackLoaded.dir}（有人设卡的剧本: ${withCards.join('、') || '无'}；其余剧本由角色定义生成简卡）`);
  } else console.log('  提示词包: 没找到 prompts/ 目录，用内置占位提示词（设 PROMPTS_DIR 可指定）');
  console.log(`  说书人模型: ${catalog.tiers.storyteller}；核心: ${catalog.tiers.core.join('/')}；路人: ${catalog.tiers.extra.join('/')}`);
});
