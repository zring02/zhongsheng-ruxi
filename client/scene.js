import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const EMOJI = { wave: '👋', laugh: '😂', think: '🤔', sad: '😢', dance: '💃', sleep: '💤', angry: '😠', love: '❤️' };
/** 朝向 → 小人绕 y 轴的角度（小人正面是局部 +z） */
const FACING_YAW = { north: Math.PI, east: Math.PI / 2, south: 0, west: -Math.PI / 2 };

function label(className, html) {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = html;
  return new CSS2DObject(el);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts });
}

/** 把一个 Object3D 子树从场景里拿掉，顺带释放几何体/材质并移除 CSS2D 标签的 DOM */
function disposeTree(scene, root) {
  scene.remove(root);
  root.traverse((o) => {
    if (o.isCSS2DObject && o.element?.parentNode) o.element.remove();
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

// —— 方块世界渲染 ——————————————————————————————————————————

/**
 * 每种方块一个 InstancedMesh，只画露在外面的方块。
 * 世界不大（48×20×48），有改动时整体重建一次就够了（几毫秒）。
 */
export class VoxelRenderer {
  constructor(scene, size, blockTypes) {
    this.scene = scene;
    this.size = size;
    this.types = blockTypes;
    this.data = new Uint8Array(size.x * size.y * size.z);
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.mats = blockTypes.map((t) => mat(t.color, { flatShading: true }));
    this.meshes = [];
    this.pending = 0;
  }

  idx(x, y, z) {
    return (y * this.size.z + z) * this.size.x + x;
  }

  get(x, y, z) {
    if (y < 0) return 8; // 地底当作基岩
    if (x < 0 || z < 0 || y >= this.size.y || x >= this.size.x || z >= this.size.z) return 0;
    return this.data[this.idx(x, y, z)];
  }

  solid(x, y, z) {
    const t = this.types[this.get(x, y, z)];
    return t ? t.solid : false;
  }

  load(base64) {
    const bin = atob(base64);
    for (let i = 0; i < bin.length && i < this.data.length; i++) this.data[i] = bin.charCodeAt(i);
    this.rebuild();
  }

  apply(changes) {
    for (const c of changes) if (c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < this.size.x && c.y < this.size.y && c.z < this.size.z) this.data[this.idx(c.x, c.y, c.z)] = c.id;
    if (!this.pending) {
      this.pending = requestAnimationFrame(() => {
        this.pending = 0;
        this.rebuild();
      });
    }
  }

  rebuild() {
    const t0 = performance.now();
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    this.meshes = [];
    const lists = this.types.map(() => []);
    const { x: SX, y: SY, z: SZ } = this.size;
    for (let y = 0; y < SY; y++) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          const id = this.data[this.idx(x, y, z)];
          if (!id) continue;
          const hidden = this.solid(x + 1, y, z) && this.solid(x - 1, y, z) && this.solid(x, y + 1, z) && this.solid(x, y - 1, z) && this.solid(x, y, z + 1) && this.solid(x, y, z - 1);
          if (hidden) continue;
          lists[id].push(x, y, z);
        }
      }
    }
    const m4 = new THREE.Matrix4();
    lists.forEach((cells, id) => {
      if (!cells.length || !this.mats[id]) return;
      const mesh = new THREE.InstancedMesh(this.geo, this.mats[id], cells.length / 3);
      for (let k = 0; k < cells.length; k += 3) {
        m4.makeTranslation(cells[k] + 0.5, cells[k + 1] + 0.5, cells[k + 2] + 0.5);
        mesh.setMatrixAt(k / 3, m4);
      }
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this.meshes.push(mesh);
    });
    this.lastRebuild = { ms: performance.now() - t0, instances: lists.reduce((n, l) => n + l.length / 3, 0) };
    console.debug(`[voxels] 重建 ${SX}×${SY}×${SZ}：${this.lastRebuild.instances} 个可见方块，${this.lastRebuild.ms.toFixed(1)} ms`);
  }

  /** 结算时让玩家亲手放的方块发光：在这些格子上套一层半透明的发光盒 */
  setGlow(positions) {
    this.clearGlow();
    if (!positions?.length) return;
    this.glowMat = new THREE.MeshStandardMaterial({ color: '#ffd166', emissive: '#ffb347', emissiveIntensity: 1.2, transparent: true, opacity: 0.55, depthWrite: false });
    this.glowGeo = new THREE.BoxGeometry(1.06, 1.06, 1.06);
    this.glow = new THREE.InstancedMesh(this.glowGeo, this.glowMat, positions.length);
    const m4 = new THREE.Matrix4();
    positions.forEach((p, i) => this.glow.setMatrixAt(i, m4.makeTranslation(p.x + 0.5, p.y + 0.5, p.z + 0.5)));
    this.glow.instanceMatrix.needsUpdate = true;
    this.scene.add(this.glow);
  }

  clearGlow() {
    if (!this.glow) return;
    this.scene.remove(this.glow);
    this.glow.dispose();
    this.glowGeo.dispose();
    this.glowMat.dispose();
    this.glow = null;
  }

  /** 换局时整个世界连同材质一起释放（方块颜色会随剧本变） */
  dispose() {
    if (this.pending) cancelAnimationFrame(this.pending);
    this.pending = 0;
    this.clearGlow();
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    this.meshes = [];
    this.geo.dispose();
    for (const m of this.mats) m.dispose();
  }
}

/** 给每个地标挂一个名字标签，返回标签对象数组，换局时交给 removeLabels */
export function addLandmarkLabels(scene, landmarks) {
  const tags = [];
  for (const l of landmarks) {
    const tag = label('place-label', esc(l.name));
    tag.position.set(l.pos.x + 0.5, l.pos.y + 3.5, l.pos.z + 0.5);
    scene.add(tag);
    tags.push(tag);
  }
  return tags;
}

export function removeLabels(scene, tags) {
  for (const t of tags) disposeTree(scene, t);
}

// —— 角色 ————————————————————————————————————————————————————

/** 一个居民的 3D 小人：身体、头、眼睛、名牌、对话气泡、表情、选中光环。身高约 1.9 格 */
export class Character {
  constructor(scene, data) {
    this.id = data.id;
    this.scene = scene;
    this.group = new THREE.Group();
    // 点击场景时射线命中哪个网格，往上找到带 id 的 group 就知道点的是谁
    this.group.userData.id = data.id;
    this.body = new THREE.Group(); // 用于走路弹跳和表情动画
    this.group.add(this.body);

    const color = new THREE.Color(data.color);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.4), mat(color));
    torso.position.y = 0.9;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat('#ffe0bd'));
    head.position.y = 1.6;
    const eyeGeo = new THREE.BoxGeometry(0.08, 0.08, 0.04);
    const eyeMat = mat('#222');
    for (const x of [-0.12, 0.12]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(x, 1.65, 0.26);
      this.body.add(eye);
    }
    const legGeo = new THREE.BoxGeometry(0.22, 0.5, 0.3);
    this.legs = [-0.15, 0.15].map((x) => {
      const leg = new THREE.Mesh(legGeo, mat(color.clone().multiplyScalar(0.7)));
      leg.position.set(x, 0.25, 0);
      leg.castShadow = true;
      this.body.add(leg);
      return leg;
    });
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.12, 0.56), mat(color));
    hat.position.y = 1.9;
    torso.castShadow = head.castShadow = hat.castShadow = true;
    this.body.add(torso, head, hat);

    // 选中光环：脚下一个圈，默认隐藏
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 32), new THREE.MeshBasicMaterial({ color: '#ffd166', side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.ring.visible = false;
    this.group.add(this.ring);

    // 名牌：名字 + 模型（玩家显示“玩家”）
    const sub = data.kind === 'player' ? '玩家' : `${esc(data.providerLabel)}${data.model ? ' · ' + esc(data.model) : ''}`;
    this.plate = label('nameplate', `<div class="name">${esc(data.name)}</div><div class="model" style="background:${esc(data.color)}">${sub}</div>`);
    this.plate.position.y = 2.4;
    this.group.add(this.plate);

    this.bubble = label('bubble hidden', '');
    this.bubble.position.y = 3.2;
    this.group.add(this.bubble);

    this.emoteTag = label('emote', '');
    this.emoteTag.position.set(0.6, 2.0, 0);
    this.group.add(this.emoteTag);

    this.target = new THREE.Vector3();
    this.setTarget(data.pos);
    this.group.position.copy(this.target);
    this.yaw = FACING_YAW[data.facing] ?? 0;
    this.group.rotation.y = this.yaw;
    this.moving = false;
    this.thinking = false;
    this.emote = null;
    this.bubbleUntil = 0;
    this.phase = Math.random() * 10;
    scene.add(this.group);
  }

  setTarget(pos) {
    this.target.set(pos.x + 0.5, pos.y, pos.z + 0.5);
  }

  update(data) {
    this.setTarget(data.pos);
    this.yaw = FACING_YAW[data.facing] ?? this.yaw;
    this.moving = data.moving;
    this.emote = data.emote;
    this.emoteTag.element.textContent = data.emote ? (EMOJI[data.emote] ?? data.emote) : '';
    this.plate.element.classList.toggle('jailed', data.jailed > 0);
    if (data.thinking !== this.thinking) {
      this.thinking = data.thinking;
      if (data.thinking && performance.now() > this.bubbleUntil) this.showBubble('…', 0, true);
      else if (!data.thinking && this.bubble.element.classList.contains('thinking')) this.hideBubble();
    }
  }

  setSelected(on) {
    this.ring.visible = on;
    this.plate.element.classList.toggle('selected', on);
  }

  say(text, ms = 4000) {
    this.showBubble(text, ms, false, false);
  }

  /** 私聊气泡：样式不同，只有看得到这条私聊的视角才会收到 */
  whisper(text, ms = 4000) {
    this.showBubble(text, ms, false, true);
  }

  showBubble(text, ms, thinking, whisper = false) {
    const el = this.bubble.element;
    el.textContent = text;
    el.classList.toggle('thinking', thinking);
    el.classList.toggle('whisper', whisper);
    el.classList.remove('hidden');
    this.bubbleUntil = ms ? performance.now() + ms : 0;
  }

  hideBubble() {
    this.bubble.element.classList.add('hidden');
  }

  tick(dt, t) {
    // 服务端 200ms 推一次格子坐标，这里平滑插值
    this.group.position.lerp(this.target, Math.min(1, dt * 8));
    const dyaw = ((this.yaw - this.group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.group.rotation.y += dyaw * Math.min(1, dt * 10);
    const p = t * 0.001 + this.phase;
    const walking = this.moving || this.group.position.distanceToSquared(this.target) > 0.01;
    this.body.position.y = walking ? Math.abs(Math.sin(p * 10)) * 0.08 : 0;
    this.legs[0].rotation.x = walking ? Math.sin(p * 10) * 0.6 : 0;
    this.legs[1].rotation.x = walking ? -Math.sin(p * 10) * 0.6 : 0;
    this.body.rotation.z = this.emote === 'dance' ? Math.sin(p * 8) * 0.3 : this.emote === 'wave' ? Math.sin(p * 12) * 0.12 : 0;
    this.body.rotation.y = this.emote === 'dance' ? p * 4 : 0;
    this.body.rotation.x = this.emote === 'sleep' ? 0.25 : this.emote === 'sad' ? 0.15 : 0;
    if (this.emote === 'laugh') this.body.position.y = Math.abs(Math.sin(p * 14)) * 0.1;
    // 等模型回话时慢慢晃一晃、微微侧头，看起来像在想事情
    if (this.thinking && !walking && !this.emote) {
      this.body.position.y = 0.03 + Math.sin(p * 2) * 0.03;
      this.body.rotation.z = Math.sin(p * 1.3) * 0.06;
    }
    if (this.ring.visible) this.ring.material.opacity = 0.6 + 0.3 * Math.sin(p * 4);
    if (this.bubbleUntil && performance.now() > this.bubbleUntil) {
      this.bubbleUntil = 0;
      this.hideBubble();
    }
  }

  /** 换局 / 角色消失时彻底移除：网格、材质、名牌和气泡的 DOM */
  dispose() {
    disposeTree(this.scene, this.group);
  }
}
