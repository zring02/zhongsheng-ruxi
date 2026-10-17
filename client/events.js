// 把 WorldEvent 变成「小镇动态」里的一行。所有文案都在这里，便于统一改。

export const EMOTE_CN = { wave: '挥手', laugh: '大笑', think: '沉思', sad: '难过', dance: '跳舞', sleep: '打盹', angry: '生气', love: '比心' };
export const PHASE_CN = { morning: '早上', noon: '中午', evening: '傍晚', night: '夜里' };
export const GENRE_CN = { modern: '现代', ancient: '古代', fantasy: '奇幻', scifi: '科幻', book: '穿书', custom: '自定义' };
export const ACTIVITY_CN = { quiet: '安静', normal: '正常', dramatic: '戏多' };
export const DIFFICULTY_CN = { easy: '宽厚', normal: '寻常', hard: '精明' };

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function tag(text, cls = '') {
  return span(`tag ${cls}`.trim(), text);
}

/**
 * @param ev WorldEvent
 * @param ctx { nameOf(id), colorOf(id), itemName(key), viewer: 玩家id|null }
 * @returns HTMLLIElement，带 class：kind-<kind>、talk（对话类，供“只看对话”过滤）以及样式用的 dim/private/alert/gold/system
 */
export function renderEventLine(ev, ctx) {
  const li = document.createElement('li');
  li.classList.add(`kind-${ev.kind}`);
  const time = new Date(ev.t).toLocaleTimeString('zh-CN', { hour12: false });
  li.appendChild(span('t', time));

  const body = document.createElement('span');
  body.className = 'body';
  li.appendChild(body);

  const who = () => {
    const w = span('who', ctx.nameOf(ev.agentId));
    w.style.color = ctx.colorOf(ev.agentId) ?? '#fff';
    body.appendChild(w);
    body.appendChild(document.createTextNode(' '));
  };
  const text = (t) => body.appendChild(document.createTextNode(t));
  const n = (id) => ctx.nameOf(id);
  const item = (k) => ctx.itemName(k);
  const isMe = (id) => ctx.viewer && id === ctx.viewer;

  switch (ev.kind) {
    case 'say':
      li.classList.add('talk');
      who();
      text(`${ev.to ? `对${n(ev.to)}` : ''}说：“${ev.text}”`);
      break;
    case 'whisper':
      li.classList.add('talk', 'private');
      body.appendChild(tag('私聊', 'private'));
      who();
      if (ctx.viewer && ev.agentId !== ctx.viewer && ev.to !== ctx.viewer) text('（你偷听到）');
      text(`悄悄对${n(ev.to)}说：“${ev.text}”`);
      break;
    case 'notice':
      li.classList.add('private', 'notice');
      body.appendChild(tag('私下消息', 'private'));
      text(ev.text);
      break;
    case 'wechat':
      li.classList.add('talk', 'private', 'wechat');
      body.appendChild(tag('微信', 'wechat'));
      who();
      text(`给${n(ev.to)}发微信：“${ev.text}”`);
      break;
    case 'letter':
      // agentId 是读信的人：收信人自己收到了，或者别人拆开了
      li.classList.add('talk', 'private', 'letter');
      body.appendChild(tag('信', 'letter'));
      who();
      text(ev.agentId === ev.to ? `收到了${n(ev.from)}的信：“${ev.text}”` : `读了${n(ev.from)}写给${n(ev.to)}的信：“${ev.text}”`);
      break;
    case 'sneak':
      li.classList.add('private', 'sneak');
      body.appendChild(tag('得手', 'private'));
      who();
      text(ev.what === 'steal' ? `从${n(ev.target)}身上摸走了${item(ev.item ?? '东西')}` : `开始偷听${n(ev.target)}`);
      break;
    case 'caught':
      li.classList.add('alert');
      body.appendChild(tag('抓住了', 'alert'));
      who();
      text(`${ev.what === 'steal' ? '偷' : '偷听'}${n(ev.target)}时被${n(ev.by)}当场抓住：${ev.penalty}`);
      break;
    case 'fail':
      li.classList.add('fail', 'private');
      who();
      text(`✗ ${ev.text}`);
      break;
    case 'give':
      who();
      text(`把${item(ev.item)}×${ev.count}给了${n(ev.to)}`);
      break;
    case 'chest':
      who();
      text(`${ev.op === 'put' ? '往箱子里放了' : '从箱子里取了'}${item(ev.item)}×${ev.count}`);
      break;
    case 'block':
      li.classList.add('dim');
      who();
      text(`在 (${ev.pos.x},${ev.pos.y},${ev.pos.z}) ${ev.op === 'break' ? '挖掉了' : '放了'}${item(ev.block)}`);
      break;
    case 'move':
      li.classList.add('dim');
      who();
      text(`动身前往${ev.target}`);
      break;
    case 'arrive':
      li.classList.add('dim');
      who();
      text(`到达${ev.target}`);
      break;
    case 'emote':
      who();
      text(`${EMOTE_CN[ev.emote] ?? ev.emote}`);
      break;
    case 'story': {
      li.classList.add('gold', 'story');
      body.appendChild(tag('说书人', 'gold'));
      body.appendChild(span('title', ev.title));
      if (ev.requestedBy) text(`（应${isMe(ev.requestedBy) ? '你' : n(ev.requestedBy)}的请求）`);
      body.appendChild(document.createElement('br'));
      text(ev.text);
      break;
    }
    case 'chapter':
      li.classList.add('gold', 'chapter');
      body.appendChild(tag(`第${ev.day}回`, 'gold'));
      body.appendChild(span('title', ev.title));
      body.appendChild(document.createElement('br'));
      text(ev.text);
      break;
    case 'ending':
      li.classList.add('gold', 'ending');
      body.appendChild(tag('结局', 'gold'));
      body.appendChild(span('title', ev.title));
      body.appendChild(document.createElement('br'));
      text(ev.text);
      break;
    case 'game':
      li.classList.add('system');
      text(ev.text);
      break;
    case 'system':
      li.classList.add('system', 'dim');
      text(ev.text);
      break;
    case 'thought':
      li.classList.add('dim', 'thought');
      who();
      text(`💭 ${ev.text}${ev.because ? `（因为：${ev.because}）` : ''}`);
      break;
    case 'error':
      li.classList.add('dim', 'error');
      who();
      text(`⚠ ${ev.text}`);
      break;
    default:
      if (ev.agentId) who();
      text(ev.text ?? JSON.stringify(ev));
  }
  return li;
}
