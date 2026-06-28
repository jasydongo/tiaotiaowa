/* =====================================================================
 * 蛙一跳 · Jumping Frog
 * 类似微信「跳一跳」玩法的 WEB 小游戏 —— 森林木桩 / 蘑菇主题
 * 纯原生 Canvas 2D + 等距斜投影伪 3D，无第三方依赖
 *
 * 结构总览：
 *   CONST       全局常量（尺寸、物理、颜色）
 *   Util        数学/随机小工具
 *   Input       统一输入（鼠标 / 触摸 / 空格）
 *   Audio       Web Audio 合成音效
 *   Storage     最高分读写
 *   Platform    平台对象（木桩/蘑菇/石台）
 *   Frog        青蛙角色（蓄力 / 跳跃 / 形变）
 *   Particles   粒子系统（落地、完美、背景萤火虫）
 *   Camera      镜头跟随 + 世界->屏幕投影
 *   Renderer    绘制（背景视差 / 平台 / 青蛙 / 阴影 / HUD）
 *   Game        状态机 + 主循环
 * ===================================================================== */
(function () {
  'use strict';

  /* ===================== 全局常量 ===================== */
  const CONST = {
    // 等距投影：前进方向 worldX 沿右下，左右偏移 worldY 沿左下
    // 屏幕坐标：screenX = ox + (worldX - worldY) * tw
    //          screenY = oy + (worldX + worldY) * th - height
    TW: 26,            // 单位世界长度的屏幕水平分量
    TH: 13,            // 单位世界长度的屏幕竖直分量
    GROUND_Z: 0,       // 地面高度基准

    // 平台
    PLATFORM_TOP_R: 22,        // 顶面菱形半径（世界单位）
    PLATFORM_TYPES: ['stump', 'mushroom', 'stone', 'leaf', 'tower'],
    PLATFORM_MIN_GAP: 2.0,     // 平台间最小世界距离
    PLATFORM_MAX_GAP: 6.8,     // 平台间最大世界距离
    PLATFORM_MAX_OFFSET: 4.5,   // 左右最大偏移（worldY）

    // 玻璃平台（特殊）：每跳 GLASS_INTERVAL 次出现，落上触发 GLASS_AUTO_JUMPS 次自动连跳
    GLASS_INTERVAL: 20,        // 每多少次跳跃生成一次玻璃平台
    GLASS_AUTO_JUMPS: 3,       // 触发自动连续跳跃的次数
    GLASS_AUTO_DELAY: 0.45,    // 自动起跳前在平台上停留的秒数（视觉缓冲）

    // 蓄力与跳跃物理
    CHARGE_RATE: 0.8,          // 每秒蓄力增长
    CHARGE_MAX: 1.0,
    JUMP_TIME_MIN: 0.32,
    JUMP_TIME_MAX: 1.15,
    JUMP_DIST_MAX: 11.5,       // 满蓄力最远世界距离（增大以支持从平台边缘跳跃）
    JUMP_HEIGHT_MAX: 150,      // 像素最大高度（视觉）
    PERFECT_RADIUS: 7,         // 完美落地判定半径（屏幕像素）

    // 镜头
    CAM_FOLLOW: 2.4,           // 镜头跟随平滑系数

    // 青蛙绘制
    FROG_FEET_OFFSET: 13,      // 绘制整体上抬（像素）：锚点(脚掌)落在平台顶面中心，身体立于其上

    // 游戏难度
    SCORE_PER_LAND: 1,
    PERFECT_BASE: 2,
  };

  /* ===================== 工具函数 ===================== */
  const Util = {
    clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
    lerp(a, b, t) { return a + (b - a) * t; },
    rand(min, max) { return min + Math.random() * (max - min); },
    randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); },
    pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
    // 帧率无关的平滑插值
    damp(current, target, lambda, dt) {
      return Util.lerp(current, target, 1 - Math.exp(-lambda * dt));
    },
    // 缓动
    easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); },
  };

  /* ===================== 输入 ===================== */
  // 统一处理 按下/抬起，对外只暴露 onPressStart / onPressEnd
  class Input {
    constructor(canvas, { onStart, onEnd }) {
      this.canvas = canvas;
      this.onStart = onStart;
      this.onEnd = onEnd;
      this.pressing = false;
      this.spaceDown = false; // 阻止空格连发 keydown

      // 鼠标
      canvas.addEventListener('mousedown', (e) => { e.preventDefault(); this.start(); });
      window.addEventListener('mouseup', (e) => { if (this.pressing) this.end(); });
      // 触摸
      canvas.addEventListener('touchstart', (e) => { e.preventDefault(); this.start(); }, { passive: false });
      window.addEventListener('touchend', (e) => { if (this.pressing) { e.preventDefault(); this.end(); } }, { passive: false });
      // 键盘
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !this.spaceDown) {
          e.preventDefault(); this.spaceDown = true; this.start();
        }
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
          e.preventDefault(); this.spaceDown = false;
          if (this.pressing) this.end();
        }
      });
      // 失焦自动松开
      window.addEventListener('blur', () => { if (this.pressing) this.end(); });
    }
    start() {
      if (this.pressing) return;
      this.pressing = true;
      this.onStart && this.onStart();
    }
    end() {
      if (!this.pressing) return;
      this.pressing = false;
      this.onEnd && this.onEnd();
    }
  }

  /* ===================== 音效（Web Audio 合成） ===================== */
  class Audio {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.master = null;
      this.bgmOscillator = null;
      this.bgmGain = null;
      this.bgmPlaying = false;
      this.bgmVolume = 0.15;
      this.bgmNotes = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25]; // C4-C5 音阶
      this.bgmCurrentNote = 0;
      this.bgmInterval = null;
    }
    _ensure() {
      if (this.ctx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) { /* 不支持则静默 */ }
    }
    resume() {
      this._ensure();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }
    // 单个正弦/三角音
    _tone(freq, dur, type = 'sine', vol = 0.5, slideTo = null) {
      if (!this.enabled || !this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
    charge() { this._tone(180, 0.12, 'sine', 0.18, 240); }
    jump() { this._tone(520, 0.18, 'triangle', 0.4, 880); }
    land() { this._tone(300, 0.1, 'sine', 0.32, 180); }
    perfect() {
      this._tone(660, 0.12, 'triangle', 0.4, 990);
      setTimeout(() => this._tone(990, 0.16, 'triangle', 0.4, 1320), 80);
    }
    fail() {
      this._tone(200, 0.5, 'sawtooth', 0.35, 70);
    }
    toggle() { 
      this.enabled = !this.enabled;
      // 如果禁用音效，停止背景音乐；如果启用音效，且当前不在游戏中，则开始播放背景音乐
      if (!this.enabled) {
        this.stopBgm();
      } else {
        this.startBgm();
      }
      return this.enabled;
    }
    
    // 播放背景音乐
    startBgm() {
      if (!this.enabled || this.bgmPlaying) return;
      this._ensure();
      if (!this.ctx) return;
      
      this.bgmPlaying = true;
      this.bgmCurrentNote = 0;
      this._playNextBgmNote();
      
      // 每 400ms 播放下一个音符
      this.bgmInterval = setInterval(() => {
        if (this.bgmPlaying && this.enabled) {
          this._playNextBgmNote();
        }
      }, 400);
    }
    
    // 停止背景音乐
    stopBgm() {
      if (!this.bgmPlaying) return;
      
      this.bgmPlaying = false;
      if (this.bgmInterval) {
        clearInterval(this.bgmInterval);
        this.bgmInterval = null;
      }
      
      if (this.bgmOscillator) {
        try {
          this.bgmOscillator.stop();
        } catch (e) {
          // 忽略已停止的错误
        }
        this.bgmOscillator = null;
      }
      
      if (this.bgmGain) {
        this.bgmGain = null;
      }
    }
    
    // 播放下一个背景音乐音符
    _playNextBgmNote() {
      if (!this.ctx || !this.enabled) return;
      
      // 停止上一个音符
      if (this.bgmOscillator) {
        try {
          this.bgmOscillator.stop();
        } catch (e) {
          // 忽略已停止的错误
        }
      }
      
      // 创建新的音符
      const t0 = this.ctx.currentTime;
      const note = this.bgmNotes[this.bgmCurrentNote];
      
      this.bgmOscillator = this.ctx.createOscillator();
      this.bgmGain = this.ctx.createGain();
      
      this.bgmOscillator.type = 'sine';
      this.bgmOscillator.frequency.setValueAtTime(note, t0);
      
      this.bgmGain.gain.setValueAtTime(0, t0);
      this.bgmGain.gain.linearRampToValueAtTime(this.bgmVolume, t0 + 0.05);
      this.bgmGain.gain.linearRampToValueAtTime(0, t0 + 0.35);
      
      this.bgmOscillator.connect(this.bgmGain).connect(this.master);
      this.bgmOscillator.start(t0);
      this.bgmOscillator.stop(t0 + 0.4);
      
      // 移动到下一个音符
      this.bgmCurrentNote = (this.bgmCurrentNote + 1) % this.bgmNotes.length;
    }
  }

  /* ===================== 存档 ===================== */
  const Storage = {
    KEY: 'tiao_tiao_wa_best',
    get() {
      const v = parseInt(localStorage.getItem(this.KEY) || '0', 10);
      return isNaN(v) ? 0 : v;
    },
    set(v) {
      try { localStorage.setItem(this.KEY, String(v)); } catch (e) { /* ignore */ }
    },
  };

  /* ===================== 平台 ===================== */
  // worldX 前进方向，worldY 左右偏移（左为正），height 平台高度（像素）
  class Platform {
    constructor(worldX, worldY, type) {
      this.worldX = worldX;
      this.worldY = worldY;
      this.type = type;
      // 不同类型尺寸/高度（topR 为世界单位，×TW(=26) 后才是屏幕像素）
      const sizeMap = {
        stump:    { topR: 1.0, height: 64, sway: 0 },
        mushroom: { topR: 1.1, height: 30, sway: 0.6 }, // 蘑菇略软
        stone:    { topR: 0.9, height: 22, sway: 0 },
        leaf:     { topR: 1.4, height: 12, sway: 0.8 }, // 荷叶，大而矮、略软
        tower:    { topR: 0.8, height: 96, sway: 0 },   // 树桩高塔，高而窄
        glass:    { topR: 1.1, height: 34, sway: 0 },   // 玻璃：中等大小、略矮，带辉光
      };
      const s = sizeMap[type];
      this.topR = s.topR;
      this.height = s.height;
      this.sway = s.sway;
      // 随机种子，用于木纹/斑点位置稳定
      this.seed = Math.random() * 1000;
      // 落地弹动动画
      this.bounce = 0;
    }
    // 平台中心在屏幕的落点（不含 height 上抬），由 Camera 投影
  }

  /* ===================== 青蛙 ===================== */
  class Frog {
    constructor() {
      this.reset(0, 0, 0);
    }
    // 站在某平台中心
    reset(worldX, worldY, baseZ) {
      this.worldX = worldX;
      this.worldY = worldY;
      this.baseZ = baseZ;     // 当前站立平台顶面高度（像素）
      this.z = baseZ;         // 当前高度（含跳跃）
      this.charge = 0;        // 蓄力 0~1
      // 跳跃状态
      this.jumping = false;
      this.jumpT = 0;
      this.jumpDur = 0;
      this.fromX = 0; this.fromY = 0; this.fromZ = 0;
      this.toX = 0; this.toY = 0; this.toZ = 0;
      // 视觉
      this.spin = 0;          // 空中翻转角度
      this.scaleX = 1; this.scaleY = 1; // 形变
      this.facing = 1;        // 朝向（左右）：1 朝右
      this.landSquash = 0;    // 落地挤压残值
      // 掉落状态
      this.falling = false;
      this.fallGrounded = false;
      this.fallVelocityZ = 0;
      // 待机动画（仅在 READY 蹲在平台上时推进）
      this.idleTime = Math.random() * 6;  // 呼吸相位起点（随机化，避免每次同步）
      this.blinkTimer = Util.rand(2.5, 5.5); // 距离下一次眨眼的倒计时
      this.blinkAnim = 0;    // 眨眼进度 0..1（>0 表示正在眨，sin 包络做闭-睁）
    }
    // 蓄力（每帧）
    charging(dt) {
      this.charge = Util.clamp(this.charge + dt * CONST.CHARGE_RATE, 0, CONST.CHARGE_MAX);
      // 蓄力下蹲：纵向压扁、横向变胖
      const c = this.charge;
      this.scaleX = 1 + c * 0.35;
      this.scaleY = 1 - c * 0.32;
      this.z = this.baseZ; // 仍在平台顶面
    }
    // 起跳：根据蓄力计算目标点
    jump(targetX, targetY, targetZ) {
      const c = this.charge;
      this.jumping = true;
      this.jumpT = 0;
      this.jumpDur = Util.lerp(CONST.JUMP_TIME_MIN, CONST.JUMP_TIME_MAX, c);
      this.fromX = this.worldX; this.fromY = this.worldY; this.fromZ = this.baseZ;
      this.toX = targetX; this.toY = targetY; this.toZ = targetZ;
      // 朝向目标
      this.facing = (targetX - this.fromX) >= 0 ? 1 : -1;
      this.spin = 0;
      this.charge = 0;
      this.scaleX = 1; this.scaleY = 1;
    }
    // 跳跃推进（每帧），返回 true 表示落地
    updateJump(dt) {
      if (!this.jumping) return false;
      this.jumpT += dt;
      let t = this.jumpT / this.jumpDur;
      let landed = false;
      if (t >= 1) { t = 1; landed = true; }
      // 水平插值
      this.worldX = Util.lerp(this.fromX, this.toX, t);
      this.worldY = Util.lerp(this.fromY, this.toY, t);
      // 抛物线高度：4*h*t*(1-t)
      const h = Util.lerp(40, CONST.JUMP_HEIGHT_MAX, this.jumpDur / CONST.JUMP_TIME_MAX);
      this.z = this.fromZ + (this.toZ - this.fromZ) * t + 4 * h * t * (1 - t);
      // （已禁用空中翻转）
      // 空中轻微拉伸
      this.scaleX = 0.95;
      this.scaleY = 1.1;
      if (landed) {
        this.jumping = false;
        this.baseZ = this.toZ;
        this.z = this.toZ;
        this.landSquash = 1;
      }
      return landed;
    }
    // 落地挤压回弹（每帧）
    updateLand(dt) {
      if (this.landSquash > 0) {
        this.landSquash = Math.max(0, this.landSquash - dt * 4);
        const s = this.landSquash;
        this.scaleX = 1 + s * 0.4;
        this.scaleY = 1 - s * 0.3;
      } else if (!this.jumping && this.charge === 0) {
        // 静止呼吸
        this.scaleX = Util.damp(this.scaleX, 1, 8, dt);
        this.scaleY = Util.damp(this.scaleY, 1, 8, dt);
      }
    }

    // 待机动画：呼吸起伏 + 微浮 + 眨眼（仅在 READY 蹲在平台上时调用）
    updateIdle(dt) {
      this.idleTime += dt;
      // 眨眼计时
      this.blinkTimer -= dt;
      if (this.blinkAnim > 0) {
        // 眨眼包络：约 0.16s 内闭-睁
        this.blinkAnim -= dt / 0.16;
        if (this.blinkAnim < 0) this.blinkAnim = 0;
      }
      if (this.blinkTimer <= 0) {
        this.blinkAnim = 1;
        this.blinkTimer = Util.rand(2.5, 6); // 下次眨眼间隔（随机化）
      }
      // 仅当没有其它形变（蓄力/落地）在影响 scale 时，叠加呼吸
      if (this.charge === 0 && this.landSquash === 0 && !this.jumping) {
        const breath = Math.sin(this.idleTime * 2.0) * 0.04; // 呼吸：纵向 ±4%
        this.scaleX = 1 - breath * 0.5;
        this.scaleY = 1 + breath;
      }
    }

    // 开始掉落（未跳上平台时调用）
    startFalling() {
      this.falling = true;
      this.fallVelocityZ = 0;  // 垂直速度（负数表示向下）
      this.fallGrounded = false;  // 是否已经落到地面
    }

    // 掉落动画（每帧），返回 true 表示已落到地面
    updateFalling(dt) {
      if (this.fallGrounded) return true;  // 已经落地，持续返回 true
      if (!this.falling) return false;

      // 重力加速度
      const gravity = 800;
      this.fallVelocityZ -= gravity * dt;
      this.z += this.fallVelocityZ * dt;

      // 判断是否落到地面
      if (this.z <= 0) {
        this.z = 0;
        this.fallGrounded = true;
        this.falling = false;
        return true;  // 落地
      }

      return false;
    }
  }

  /* ===================== 粒子 ===================== */
  class Particle {
    constructor(x, y, vx, vy, life, color, size, gravity = 200) {
      this.x = x; this.y = y; this.vx = vx; this.vy = vy;
      this.life = life; this.maxLife = life;
      this.color = color; this.size = size; this.gravity = gravity;
    }
    update(dt) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vy += this.gravity * dt;
      this.life -= dt;
      return this.life > 0;
    }
  }

  // 背景萤火虫（持续粒子，循环往复）
  class Firefly {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.reset(true);
    }
    reset(initial) {
      this.x = Math.random() * this.W;
      this.y = initial ? Math.random() * this.H : this.H + 20;
      this.r = Util.rand(1, 2.6);
      this.vx = Util.rand(-12, 12);
      this.vy = Util.rand(-18, -6);
      this.phase = Math.random() * Math.PI * 2;
      this.glow = Util.rand(0.3, 1);
    }
    update(dt, W, H) {
      this.W = W; this.H = H;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.phase += dt * 3;
      this.vx += Util.rand(-20, 20) * dt;
      this.vy += Util.rand(-10, 10) * dt;
      this.vx = Util.clamp(this.vx, -30, 30);
      this.vy = Util.clamp(this.vy, -30, 30);
      if (this.y < -20 || this.x < -20 || this.x > W + 20) this.reset(false);
    }
  }

  /* ===================== 镜头 + 投影 ===================== */
  class Camera {
    constructor() {
      // ox/oy: 屏幕原点偏移；focusWorld: 镜头聚焦的世界坐标（青蛙附近）
      this.ox = 0; this.oy = 0;
      this.focusWX = 0; this.focusWY = 0;
      this.targetOX = 0; this.targetOY = 0;
      // 把焦点平台置于屏幕偏下中位置
      this.layoutX = 0.5; // 横向比例
      this.layoutY = 0.62; // 纵向比例
    }
    setLayout(W, H) {
      this.W = W; this.H = H;
    }
    // 跟随某个世界点
    follow(wx, wy) {
      this.focusWX = Util.damp(this.focusWX, wx, CONST.CAM_FOLLOW, 1 / 60); // 仅设置目标
      this.focusWY = Util.damp(this.focusWY, wy, CONST.CAM_FOLLOW, 1 / 60);
      this.targetOX = this.W * this.layoutX - (this.focusWX - this.focusWY) * CONST.TW;
      this.targetOY = this.H * this.layoutY - (this.focusWX + this.focusWY) * CONST.TH;
    }
    // dt 平滑更新
    update(dt) {
      this.ox = Util.damp(this.ox, this.targetOX, CONST.CAM_FOLLOW, dt);
      this.oy = Util.damp(this.oy, this.targetOY, CONST.CAM_FOLLOW, dt);
    }
    // 世界点 -> 屏幕点
    project(wx, wy, z = 0) {
      const sx = this.ox + (wx - wy) * CONST.TW;
      const sy = this.oy + (wx + wy) * CONST.TH - z;
      return { x: sx, y: sy };
    }
    // 立即对齐（重开时）
    snapTo(wx, wy) {
      this.focusWX = wx; this.focusWY = wy;
      this.targetOX = this.W * this.layoutX - (wx - wy) * CONST.TW;
      this.targetOY = this.H * this.layoutY - (wx + wy) * CONST.TH;
      this.ox = this.targetOX; this.oy = this.targetOY;
    }
  }

  /* ===================== 渲染器 ===================== */
  class Renderer {
    constructor(ctx) {
      this.ctx = ctx;
      this.fireflies = [];
      // 预生成背景剪影树（相对屏幕的固定分布）
      this._buildTrees();
    }
    _buildTrees() {
      this.trees = [];
      // 远景一层 + 中景一层
      for (let layer = 0; layer < 2; layer++) {
        const count = layer === 0 ? 9 : 6;
        const arr = [];
        for (let i = 0; i < count; i++) {
          arr.push({
            x: Math.random(),            // 屏幕横向比例
            h: Util.rand(0.32, 0.55) * (layer === 0 ? 1 : 1.3),
            w: Util.rand(0.10, 0.18),
            seed: Math.random() * 100,
          });
        }
        this.trees.push(arr);
      }
    }
    initFireflies(W, H, n = 22) {
      this.fireflies = [];
      for (let i = 0; i < n; i++) this.fireflies.push(new Firefly(W, H));
    }

    /* ---------- 背景 ---------- */
    drawBackground(W, H, time, camOX) {
      const ctx = this.ctx;
      // 天空/林冠渐变
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0a1f14');
      g.addColorStop(0.45, '#123a24');
      g.addColorStop(1, '#1c5436');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // 顶部光晕（月光穿透林冠）
      const glow = ctx.createRadialGradient(W * 0.7, H * 0.12, 10, W * 0.7, H * 0.12, H * 0.7);
      glow.addColorStop(0, 'rgba(180, 240, 200, 0.18)');
      glow.addColorStop(1, 'rgba(180, 240, 200, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // 远景树剪影（视差，随镜头水平极缓移动）
      this._drawTreeLayer(this.trees[0], W, H, '#0b2a1b', camOX * 0.02, H * 0.5);
      this._drawTreeLayer(this.trees[1], W, H, '#0e3623', camOX * 0.05, H * 0.62);

      // 地面雾气
      const fog = ctx.createLinearGradient(0, H * 0.55, 0, H);
      fog.addColorStop(0, 'rgba(120, 180, 140, 0)');
      fog.addColorStop(1, 'rgba(150, 200, 165, 0.16)');
      ctx.fillStyle = fog;
      ctx.fillRect(0, H * 0.55, W, H * 0.45);
    }
    _drawTreeLayer(arr, W, H, color, offset, baseY) {
      const ctx = this.ctx;
      ctx.fillStyle = color;
      arr.forEach(t => {
        const cx = ((t.x * W + offset) % (W + 200) + (W + 200)) % (W + 200) - 100;
        const trunkW = t.w * W * 0.25;
        const top = H - t.h * H;
        // 树干
        ctx.fillRect(cx - trunkW / 2, top + (baseY - top) * 0.4, trunkW, H - top);
        // 树冠：多个圆叠加
        const cr = t.w * W * 0.5;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(cx + (i - 1) * cr * 0.6, top + cr * 0.3, cr, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
    drawFireflies(W, H, time) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.fireflies.forEach(f => {
        const a = (0.4 + 0.6 * Math.sin(f.phase)) * f.glow;
        const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 4);
        grad.addColorStop(0, `rgba(190,255,160,${a})`);
        grad.addColorStop(1, 'rgba(190,255,160,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    /* ---------- 阴影 ---------- */
    drawShadow(cam, wx, wy, radius, alpha = 0.32) {
      const p = cam.project(wx, wy, 0); // 投到地面 z=0
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, radius, radius * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* ---------- 平台 ---------- */
    drawPlatform(cam, plat) {
      // 玻璃平台：半透明 + 辉光 + 高光，与其它平台渲染差异大，单独绘制
      if (plat.type === 'glass') return this._drawGlassPlatform(cam, plat);

      const ctx = this.ctx;
      const top = cam.project(plat.worldX, plat.worldY, plat.height);
      // 弹动：高度轻微变化
      const bounceH = Math.sin(plat.bounce * Math.PI) * 4;
      const cTop = cam.project(plat.worldX, plat.worldY, plat.height + bounceH);
      const cBase = cam.project(plat.worldX, plat.worldY, 0);
      const r = plat.topR;
      const tw = r * CONST.TW / 1; // 顶面菱形水平半径（像素）
      const thh = r * CONST.TH;

      // 菱形四顶点（顶面）
      const topPoly = [
        { x: cTop.x, y: cTop.y - thh },          // 后
        { x: cTop.x + tw, y: cTop.y },           // 右
        { x: cTop.x, y: cTop.y + thh },          // 前
        { x: cTop.x - tw, y: cTop.y },           // 左
      ];

      // 按类型上色
      const palette = {
        stump:    { top: '#7a5230', topLight: '#9a6a40', side: '#5a3c22', sideDark: '#432c1a', accent: '#3a2614' },
        mushroom: { top: '#d9443a', topLight: '#ee6a5a', side: '#efe6d0', sideDark: '#cdbfa0', accent: '#ffffff' },
        stone:    { top: '#8a8f95', topLight: '#a4a9af', side: '#5f6469', sideDark: '#474b4f', accent: '#3c4044' },
        leaf:     { top: '#3fae57', topLight: '#5fc977', side: '#2c7a3d', sideDark: '#1f5a2c', accent: '#bdf0c8' },
        tower:    { top: '#8a6238', topLight: '#a87a4a', side: '#6a4a2a', sideDark: '#503620', accent: '#3a2614' },
      };
      const c = palette[plat.type];

      // 侧面：从顶面前两点向下延伸到底面
      // 前面（朝向观察者）= 顶面 [右, 前, 左] 的下边缘
      const basePoly = [
        { x: cBase.x + tw, y: cBase.y },
        { x: cBase.x, y: cBase.y + thh },
        { x: cBase.x - tw, y: cBase.y },
      ];
      // 右侧面
      ctx.fillStyle = c.sideDark;
      ctx.beginPath();
      ctx.moveTo(topPoly[1].x, topPoly[1].y);
      ctx.lineTo(topPoly[2].x, topPoly[2].y);
      ctx.lineTo(basePoly[1].x, basePoly[1].y);
      ctx.lineTo(basePoly[0].x, basePoly[0].y);
      ctx.closePath();
      ctx.fill();
      // 左侧面（稍亮）
      ctx.fillStyle = c.side;
      ctx.beginPath();
      ctx.moveTo(topPoly[2].x, topPoly[2].y);
      ctx.lineTo(topPoly[3].x, topPoly[3].y);
      ctx.lineTo(basePoly[2].x, basePoly[2].y);
      ctx.lineTo(basePoly[1].x, basePoly[1].y);
      ctx.closePath();
      ctx.fill();

      // 木桩/石台/树桩高塔：在中段画几条横向纹理线
      if (plat.type === 'stump' || plat.type === 'stone' || plat.type === 'tower') {
        ctx.strokeStyle = (plat.type === 'stone') ? 'rgba(60,64,68,0.5)' : 'rgba(58,38,20,0.5)';
        ctx.lineWidth = 1;
        const lines = plat.type === 'tower' ? 5 : 3; // 高塔更高，多画几条
        for (let i = 1; i <= lines; i++) {
          const ratio = i / (lines + 1);
          const yT = Util.lerp(topPoly[2].y, basePoly[1].y, ratio);
          ctx.beginPath();
          ctx.moveTo(cTop.x - tw * (1 - ratio * 0.2), yT - thh * ratio);
          ctx.lineTo(cTop.x + tw * (1 - ratio * 0.2), yT - thh * ratio * 0);
          ctx.stroke();
        }
      }

      // 顶面菱形
      ctx.fillStyle = c.top;
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      topPoly.forEach(pt => ctx.lineTo(pt.x, pt.y));
      ctx.closePath();
      ctx.fill();
      // 顶面高光（左半）
      ctx.fillStyle = c.topLight;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      ctx.lineTo(topPoly[3].x, topPoly[3].y);
      ctx.lineTo(topPoly[2].x, topPoly[2].y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // 顶面装饰
      if (plat.type === 'mushroom') {
        // 白点
        ctx.fillStyle = c.accent;
        const dots = [[0.2, -0.1], [-0.3, 0.15], [0.35, 0.25], [-0.1, -0.3], [0.0, 0.35]];
        dots.forEach(([dx, dy]) => {
          ctx.beginPath();
          ctx.ellipse(cTop.x + dx * tw, cTop.y + dy * thh, tw * 0.13, thh * 0.16, 0, 0, Math.PI * 2);
          ctx.fill();
        });
      } else if (plat.type === 'stump' || plat.type === 'tower') {
        // 年轮
        ctx.strokeStyle = c.accent;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1.2;
        const rings = plat.type === 'tower' ? 1 : 2; // 高塔顶面窄，少画一圈
        for (let k = 1; k <= rings; k++) {
          ctx.beginPath();
          ctx.ellipse(cTop.x, cTop.y, tw * 0.3 * k, thh * 0.3 * k, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (plat.type === 'leaf') {
        // 荷叶：放射状叶脉 + 中央水珠高光
        ctx.strokeStyle = c.sideDark;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.2;
        const veins = 7;
        for (let k = 0; k < veins; k++) {
          const ang = (k / veins) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cTop.x, cTop.y);
          ctx.lineTo(cTop.x + Math.cos(ang) * tw * 0.85, cTop.y + Math.sin(ang) * thh * 0.85);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // 中央高光水珠
        ctx.fillStyle = c.accent;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.ellipse(cTop.x - tw * 0.1, cTop.y - thh * 0.15, tw * 0.16, thh * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        // 石台苔藓点
        ctx.fillStyle = '#4f8a4f';
        [[0.25, -0.1], [-0.2, 0.2]].forEach(([dx, dy]) => {
          ctx.beginPath();
          ctx.ellipse(cTop.x + dx * tw, cTop.y + dy * thh, tw * 0.18, thh * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // 平台中心标记圈（完美落点提示）—— 仅当前目标平台显示，由调用方决定
    }

    // 玻璃平台专用渲染：半透冰蓝、外发光、斜向高光、菱形描边、底座辉光
    _drawGlassPlatform(cam, plat) {
      const ctx = this.ctx;
      const bounceH = Math.sin(plat.bounce * Math.PI) * 4;
      const cTop = cam.project(plat.worldX, plat.worldY, plat.height + bounceH);
      const cBase = cam.project(plat.worldX, plat.worldY, 0);
      const r = plat.topR;
      const tw = r * CONST.TW;
      const thh = r * CONST.TH;

      const topPoly = [
        { x: cTop.x, y: cTop.y - thh },
        { x: cTop.x + tw, y: cTop.y },
        { x: cTop.x, y: cTop.y + thh },
        { x: cTop.x - tw, y: cTop.y },
      ];
      const basePoly = [
        { x: cBase.x + tw, y: cBase.y },
        { x: cBase.x, y: cBase.y + thh },
        { x: cBase.x - tw, y: cBase.y },
      ];

      // —— 地面投影辉光（外发光底盘）——
      const glow = ctx.createRadialGradient(cBase.x, cBase.y, 2, cBase.x, cBase.y, tw * 1.5);
      glow.addColorStop(0, 'rgba(150, 230, 255, 0.35)');
      glow.addColorStop(1, 'rgba(150, 230, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(cBase.x, cBase.y, tw * 1.5, thh * 1.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // —— 侧面（半透明蓝玻璃，右侧偏深）——
      ctx.fillStyle = 'rgba(70, 150, 200, 0.55)';
      ctx.beginPath();
      ctx.moveTo(topPoly[1].x, topPoly[1].y);
      ctx.lineTo(topPoly[2].x, topPoly[2].y);
      ctx.lineTo(basePoly[1].x, basePoly[1].y);
      ctx.lineTo(basePoly[0].x, basePoly[0].y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(120, 200, 235, 0.45)';
      ctx.beginPath();
      ctx.moveTo(topPoly[2].x, topPoly[2].y);
      ctx.lineTo(topPoly[3].x, topPoly[3].y);
      ctx.lineTo(basePoly[2].x, basePoly[2].y);
      ctx.lineTo(basePoly[1].x, basePoly[1].y);
      ctx.closePath();
      ctx.fill();

      // —— 顶面：浅冰蓝半透明 ——
      ctx.fillStyle = 'rgba(200, 240, 255, 0.55)';
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      topPoly.forEach(pt => ctx.lineTo(pt.x, pt.y));
      ctx.closePath();
      ctx.fill();

      // 顶面左半高光（玻璃反光）
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      ctx.lineTo(topPoly[3].x, topPoly[3].y);
      ctx.lineTo(topPoly[2].x, topPoly[2].y);
      ctx.closePath();
      ctx.fill();

      // —— 斜向高光条纹（玻璃质感的核心）——
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      topPoly.forEach(pt => ctx.lineTo(pt.x, pt.y));
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cTop.x - tw, cTop.y - thh * 0.5);
      ctx.lineTo(cTop.x + tw, cTop.y + thh * 1.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cTop.x - tw, cTop.y - thh * 1.2);
      ctx.lineTo(cTop.x + tw, cTop.y + thh * 0.8);
      ctx.stroke();
      ctx.restore();

      // —— 顶面菱形描边（勾勒玻璃边缘）——
      ctx.strokeStyle = 'rgba(220, 245, 255, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(topPoly[0].x, topPoly[0].y);
      topPoly.forEach(pt => ctx.lineTo(pt.x, pt.y));
      ctx.closePath();
      ctx.stroke();

      // 中心微光点
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.beginPath();
      ctx.ellipse(cTop.x, cTop.y, 3, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 在平台顶面中心画完美落点圈（提示）
    drawPerfectMarker(cam, plat) {
      const c = cam.project(plat.worldX, plat.worldY, plat.height);
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 7, 3.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* ---------- 青蛙 ---------- */
    drawFrog(cam, frog) {
      const p = cam.project(frog.worldX, frog.worldY, frog.z);
      const ctx = this.ctx;
      // 待机微浮：READY 时身体随呼吸轻轻上下浮动
      const idleFloat = (frog.charge === 0 && !frog.jumping && frog.landSquash === 0)
        ? Math.sin(frog.idleTime * 2.0) * 1.2   // ±1.6px 浮动
        : 0;
      ctx.save();
      // 锚点 = 青蛙脚掌所在的平台顶面中心；把身体整体上抬，使脚掌贴在中心而非身体下半身压在平台边缘
      ctx.translate(p.x, p.y - CONST.FROG_FEET_OFFSET - idleFloat);
      ctx.scale(frog.scaleX, frog.scaleY);
      // （已禁用空中翻转，青蛙保持正面朝上）

      const r = 16; // 身体半径
      // 身体（椭圆，偏绿）
      const bodyGrad = ctx.createLinearGradient(0, -r, 0, r);
      bodyGrad.addColorStop(0, '#7ed957');
      bodyGrad.addColorStop(1, '#3f9a3a');
      ctx.fillStyle = bodyGrad;
      ctx.beginPath();
      ctx.ellipse(0, 2, r, r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();

      // 肚子
      ctx.fillStyle = '#d8f5b0';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.45, r * 0.6, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();

      // 后腿（两个椭圆）
      ctx.fillStyle = '#5cbf44';
      ctx.beginPath();
      ctx.ellipse(-r * 0.7, r * 0.5, r * 0.4, r * 0.55, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.7, r * 0.5, r * 0.4, r * 0.55, -0.3, 0, Math.PI * 2);
      ctx.fill();

      // 眼睛（两只凸起的大眼）
      const eyeY = -r * 0.7;
      const eyeDX = r * 0.45;
      // 眨眼闭眼度：0=睁，1=完全闭（用 sin 包络做闭-睁过渡）
      const blinkClose = Math.sin(frog.blinkAnim * Math.PI);
      [-1, 1].forEach(s => {
        // 眼包（绿色凸起）
        ctx.fillStyle = '#7ed957';
        ctx.beginPath();
        ctx.arc(s * eyeDX, eyeY, r * 0.32, 0, Math.PI * 2);
        ctx.fill();
        // 眼白（眨眼时纵向压扁）
        ctx.fillStyle = '#ffffff';
        ctx.save();
        ctx.translate(s * eyeDX, eyeY - 1);
        ctx.scale(1, 1 - blinkClose);
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
        ctx.fill();
        // 瞳孔（朝向）
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.arc(frog.facing * 2, 1, r * 0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // 嘴（蓄力时张开）
      ctx.strokeStyle = '#2c5e22';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (frog.charge > 0.1) {
        // 张嘴
        ctx.ellipse(0, -r * 0.15, r * 0.25, r * 0.18 * frog.charge, 0, 0, Math.PI);
      } else {
        ctx.arc(0, -r * 0.1, r * 0.28, 0.15 * Math.PI, 0.85 * Math.PI);
      }
      ctx.stroke();

      ctx.restore();
    }

    /* ---------- 粒子 ---------- */
    drawParticles(parts) {
      const ctx = this.ctx;
      parts.forEach(p => {
        const a = Util.clamp(p.life / p.maxLife, 0, 1);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    /* ---------- 蓄力条（HUD 屏幕绘制） ---------- */
    drawChargeBar(W, charge, pressing) {
      if (!pressing || charge <= 0) return;
      const ctx = this.ctx;
      const bw = Math.min(220, W * 0.5);
      const bx = (W - bw) / 2;
      const by = 70;
      // 槽
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(bx - 2, by - 2, bw + 4, 14);
      // 填充（颜色随蓄力由绿->黄->红）
      const t = charge;
      const r = Math.round(120 + t * 135);
      const g = Math.round(220 - t * 150);
      const b = Math.round(90 - t * 60);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(bx, by, bw * t, 10);
    }

    /* ---------- 蓄力时的预计落点辅助线 ---------- */
    // traj: { fromX, fromY, fromZ, landX, landY, toZ, power }
    // 抛物线参数与真实跳跃 (Frog.jump/updateJump) 完全一致，故落点预测精确
    drawAimArc(cam, traj) {
      const { fromX, fromY, fromZ, landX, landY, toZ, power } = traj;
      const ctx = this.ctx;
      // 真实跳跃高度因子：取决于由蓄力推得的跳跃时长
      const jumpDur = Util.lerp(CONST.JUMP_TIME_MIN, CONST.JUMP_TIME_MAX, power);
      const h = Util.lerp(40, CONST.JUMP_HEIGHT_MAX, jumpDur / CONST.JUMP_TIME_MAX);
      const steps = 24;

      ctx.save();
      // —— 抛物轨迹（白色虚线）——
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const wx = Util.lerp(fromX, landX, t);
        const wy = Util.lerp(fromY, landY, t);
        const z = fromZ + (toZ - fromZ) * t + 4 * h * t * (1 - t);
        const p = cam.project(wx, wy, z);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // —— 预计落点标记（琥珀色靶心）——
      const lp = cam.project(landX, landY, toZ);
      ctx.strokeStyle = 'rgba(255,210,63,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(lp.x, lp.y, 9, 4.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lp.x - 5, lp.y); ctx.lineTo(lp.x + 5, lp.y);
      ctx.moveTo(lp.x, lp.y - 3); ctx.lineTo(lp.x, lp.y + 3);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ===================== 游戏（状态机 + 主循环） ===================== */
  const STATE = { READY: 'ready', CHARGING: 'charging', JUMPING: 'jumping', FALLING: 'falling', GAMEOVER: 'gameover' };

  class Game {
    constructor() {
      this.canvas = document.getElementById('game-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.W = 0; this.H = 0; this.dpr = 1;

      this.audio = new Audio();
      this.camera = new Camera();
      this.renderer = new Renderer(this.ctx);
      this.frog = new Frog();

      this.state = STATE.READY;
      this.score = 0;
      this.jumps = 0; // 本局已成功跳跃的次数
      this.best = Storage.get();
      this.combo = 0;
      this.platforms = [];
      this.currentIdx = 0; // 青蛙当前所在平台索引
      this.particles = [];
      this.time = 0;
      this.aimLineEnabled = true; // 辅助线开关状态
      // 自动连跳（玻璃平台触发）：autoJumpsLeft>0 表示正处于自动连跳中
      this.autoJumpsLeft = 0;   // 剩余自动跳跃次数
      this.autoTimer = 0;       // 自动起跳前的停留倒计时（秒）
      this.fallTimer = 0;       // 掉落后延迟结束的时间

      this._bindUI();
      this._resize();
      window.addEventListener('resize', () => this._resize());

      this.input = new Input(this.canvas, {
        onStart: () => this._onPressStart(),
        onEnd: () => this._onPressEnd(),
      });

      this._resetWorld();
      this._updateHUD();
      this._lastT = performance.now();
      
      // 开始播放背景音乐
      this.audio.startBgm();
      
      requestAnimationFrame((t) => this._loop(t));
    }

    /* ---------- 初始化 / 重置 ---------- */
    _bindUI() {
      this.elScore = document.getElementById('score');
      this.elJumps = document.getElementById('jumps');
      this.elBest = document.getElementById('best');
      this.elFinalScore = document.getElementById('final-score');
      this.elFinalJumps = document.getElementById('final-jumps');
      this.elFinalBest = document.getElementById('final-best');
      this.elOverTitle = document.getElementById('over-title');
      this.elOverMsg = document.getElementById('over-msg');
      this.elComboPop = document.getElementById('combo-pop');
      this.startScreen = document.getElementById('start-screen');
      this.overScreen = document.getElementById('over-screen');

      document.getElementById('start-btn').addEventListener('click', () => this.startGame());
      document.getElementById('restart-btn').addEventListener('click', () => this.startGame());

      const muteBtn = document.getElementById('mute-btn');
      const muteIcon = document.getElementById('mute-icon');
      muteBtn.addEventListener('click', () => {
        const on = this.audio.toggle();
        muteIcon.textContent = on ? '🔊' : '🔇';
      });

      const aimBtn = document.getElementById('aim-btn');
      const aimIcon = document.getElementById('aim-icon');
      aimBtn.addEventListener('click', () => {
        this.aimLineEnabled = !this.aimLineEnabled;
        aimIcon.textContent = this.aimLineEnabled ? '🎯' : '🚫';
        aimIcon.style.opacity = this.aimLineEnabled ? '1' : '0.5';
      });
    }

    _resize() {
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.W = window.innerWidth;
      this.H = window.innerHeight;
      this.canvas.width = Math.floor(this.W * this.dpr);
      this.canvas.height = Math.floor(this.H * this.dpr);
      this.canvas.style.width = this.W + 'px';
      this.canvas.style.height = this.H + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.camera.setLayout(this.W, this.H);
      this.renderer.initFireflies(this.W, this.H);
    }

    // 建立初始平台序列
    _resetWorld() {
      this.platforms = [];
      this.offsetDir = undefined; // 重置偏移方向
      // 起始平台（石台，固定位置）
      const start = new Platform(0, 0, 'stone');
      this.platforms.push(start);
      // 预生成若干后续平台
      for (let i = 0; i < 6; i++) this._spawnNext();
      this.currentIdx = 0;
      this.frog.reset(start.worldX, start.worldY, start.height);
      this.camera.snapTo(start.worldX, start.worldY);
      this.score = 0;
      this.jumps = 0;
      this.combo = 0;
      this.autoJumpsLeft = 0;
      this.autoTimer = 0;
      this.fallTimer = 0;
      this.particles = [];
    }

    _spawnNext() {
      const last = this.platforms[this.platforms.length - 1];
      const gap = Util.rand(CONST.PLATFORM_MIN_GAP, CONST.PLATFORM_MAX_GAP);
      // 难度：分数越高，偏移范围与间距上限略增
      const diffBoost = Util.clamp(this.score / 80, 0, 0.4);
      // 曲折排列：偏移方向交替变化，形成之字形或S形轨迹
      // 首次随机方向，之后每次有概率翻转方向
      if (this.offsetDir === undefined) {
        this.offsetDir = Math.random() > 0.5 ? 1 : -1;
      }
      // 每 2-4 个平台翻转一次方向，使路径更曲折
      if (Math.random() < 0.35) {
        this.offsetDir *= -1;
      }
      // 基础偏移 + 随机扰动，增加曲折感
      const baseOffset = this.offsetDir * (CONST.PLATFORM_MAX_OFFSET * 0.4);
      const randomOffset = Util.rand(-CONST.PLATFORM_MAX_OFFSET * 0.6, CONST.PLATFORM_MAX_OFFSET * 0.6);
      const offset = baseOffset + randomOffset + (Math.random() - 0.5) * diffBoost;
      // 玻璃平台：按绝对序号判定 —— 新平台将成为 platforms[newIdx]，亦即即将进行的
      // 第 newIdx 次跳跃的目标。当 newIdx 是 30 的倍数时为玻璃（触发连跳），且不进入随机池
      const newIdx = this.platforms.length;
      const isGlass = newIdx > 0 && newIdx % CONST.GLASS_INTERVAL === 0;
      const type = isGlass ? 'glass' : Util.pick(CONST.PLATFORM_TYPES);
      const p = new Platform(last.worldX + gap, last.worldY + offset, type);
      this.platforms.push(p);
    }

    /* ---------- 状态控制 ---------- */
    startGame() {
      this.audio.resume();
      this.startScreen.classList.add('hidden');
      this.overScreen.classList.add('hidden');
      this._resetWorld();
      this.camera.snapTo(this.platforms[0].worldX, this.platforms[0].worldY);
      this.state = STATE.READY;
      this._updateHUD();
    }

    _onPressStart() {
      // 自动连跳进行中时屏蔽玩家蓄力输入，避免打断/冲突
      if (this.state !== STATE.READY || this.autoJumpsLeft > 0) return;
      this.audio.resume();
      this.state = STATE.CHARGING;
      this.frog.charge = 0;
      this.audio.charge();
    }

    _onPressEnd() {
      if (this.state !== STATE.CHARGING) return;
      this._performJump(this.frog.charge);
      this.audio.jump();
    }

    // 执行一次跳跃（玩家松手 / 自动连跳共用）：按 power 计算轨迹并起跳
    _performJump(power) {
      const traj = this._calcJumpTrajectory(power);
      const target = this.platforms[this.currentIdx + 1];
      this.frog.facing = (target.worldX - this.frog.worldX) >= 0 ? 1 : -1;
      this.frog.jump(traj.landX, traj.landY, traj.toZ);
      this.state = STATE.JUMPING;
    }

    // 触发自动连续跳跃（落上玻璃平台时调用）
    _startAutoJumps() {
      this.autoJumpsLeft = CONST.GLASS_AUTO_JUMPS;
      this.autoTimer = CONST.GLASS_AUTO_DELAY;
    }

    // 自动起跳一次：直接朝下一平台中心跳（精确距离，确保落到平台中心）
    _performAutoJump() {
      if (this.state !== STATE.READY) return;
      const target = this.platforms[this.currentIdx + 1];
      const fromX = this.frog.worldX, fromY = this.frog.worldY;
      
      // 计算到目标平台的精确距离
      const dx = target.worldX - fromX;
      const dy = target.worldY - fromY;
      const exactDist = Math.hypot(dx, dy);
      
      // 使用精确距离对应的蓄力值（确保落到平台中心）
      const exactPower = Math.min(exactDist / CONST.JUMP_DIST_MAX, 1);
      
      this._performJump(exactPower);
      this.audio.jump();
    }

    // 根据当前蓄力计算跳跃轨迹参数（蓄力预览与实际起跳共用，保证落点预测精确）
    _calcJumpTrajectory(power) {
      const target = this.platforms[this.currentIdx + 1];
      const dist = power * CONST.JUMP_DIST_MAX;
      const fromX = this.frog.worldX, fromY = this.frog.worldY, fromZ = this.frog.baseZ;
      // 方向 = 当前平台 -> 下一平台
      const dx = target.worldX - fromX;
      const dy = target.worldY - fromY;
      const dirLen = Math.hypot(dx, dy) || 1;
      const nx = dx / dirLen, ny = dy / dirLen;
      const landX = fromX + nx * dist;
      const landY = fromY + ny * dist;
      const debugY = landY - target.worldY;
      const debugX = landX - target.worldX;
      console.log({dy:dy, dx:dx, dist:dist, nx:nx, ny:ny, fromX:fromX, fromY:fromY, landX:landX, landY:landY, debugX:debugX, debugY:debugY});
      return { fromX, fromY, fromZ, landX, landY, toZ: target.height, power };
    }

    /* ---------- 主循环 ---------- */
    _loop(now) {
      const dt = Math.min(0.04, (now - this._lastT) / 1000);
      this._lastT = now;
      this.time += dt;
      this._update(dt);
      this._render();
      requestAnimationFrame((t) => this._loop(t));
    }

    _update(dt) {
      // 背景粒子始终更新
      this.renderer.fireflies.forEach(f => f.update(dt, this.W, this.H));

      if (this.state === STATE.CHARGING) {
        this.frog.charging(dt);
        // 蓄力音效（间隔触发）
        this._chargeSfxAcc = (this._chargeSfxAcc || 0) + dt;
        if (this._chargeSfxAcc > 0.18 && this.frog.charge < 1) {
          this._chargeSfxAcc = 0;
          this.audio.charge();
        }
      } else if (this.state === STATE.JUMPING) {
        const landed = this.frog.updateJump(dt);
        if (landed) this._resolveLanding();
      } else if (this.state === STATE.FALLING) {
        const grounded = this.frog.updateFalling(dt);
        if (grounded) {
          // 落到地面，延迟 0.2 秒后结束游戏
          this.fallTimer += dt;
          if (this.fallTimer >= 0.2) {
            this._gameOver();
          }
        }
      }
      // 掉落状态下不更新落地挤压回弹
      if (this.state !== STATE.FALLING) {
        this.frog.updateLand(dt);
      }

      // 自动连跳推进：仅在 READY（蹲在平台上）时计时，到点自动起跳一次
      if (this.state === STATE.READY && this.autoJumpsLeft > 0) {
        this.autoTimer -= dt;
        if (this.autoTimer <= 0) {
          this.autoJumpsLeft -= 1;
          if (this.autoJumpsLeft > 0) {
            this.autoTimer = CONST.GLASS_AUTO_DELAY; // 还有次数：继续等待下一次自动起跳
          } else {
            this.autoTimer = 0; // 连跳结束，恢复正常操作
          }
          this._performAutoJump();
        }
      }

      // 待机动画（呼吸 / 微浮 / 眨眼）：放在 updateLand 之后，使呼吸形变
      // 在落地挤压回弹恢复之后才叠加，避免被其 damp 回 1 的分支覆盖。
      // 自动连跳中不播放待机动画（青蛙即将起跳）
      if (this.state === STATE.READY && this.autoJumpsLeft === 0) {
        this.frog.updateIdle(dt);
      }

      // 平台弹动衰减
      this.platforms.forEach(p => { if (p.bounce > 0) p.bounce = Math.max(0, p.bounce - dt * 3); });

      // 粒子
      this.particles = this.particles.filter(p => p.update(dt));

      // 镜头：跟随当前平台（READY/CHARGING）或青蛙前进方向（JUMPING）
      let fx, fy;
      if (this.state === STATE.JUMPING) {
        fx = this.frog.worldX; fy = this.frog.worldY;
      } else {
        const cur = this.platforms[this.currentIdx];
        fx = cur.worldX; fy = cur.worldY;
      }
      this.camera.follow(fx, fy);
      this.camera.update(dt);
    }

    /* ---------- 落地判定 ---------- */
    _resolveLanding() {
      const target = this.platforms[this.currentIdx + 1];
      const fx = this.frog.worldX, fy = this.frog.worldY;

      // 在世界坐标上判断是否落在目标平台顶面菱形范围内
      // 用投影到屏幕中心的距离判定（更直观）
      const cam = this.camera;
      const frogScreen = cam.project(fx, fy, 0);
      const targetScreen = cam.project(target.worldX, target.worldY, 0);
      const sd = Util.dist(frogScreen.x, frogScreen.y, targetScreen.x, targetScreen.y);

      // 判定半径：平台顶面在屏幕上的大致半径
      const r = target.topR * CONST.TW; // 水平半径像素
      const onPlatform = sd <= r;

      if (onPlatform) {
        // 成功落地
        this.currentIdx += 1;
        this.jumps += 1; // 成功跳跃次数 +1
        // 平台弹动
        target.bounce = 1;
        // 完美判定
        const perfect = sd <= CONST.PERFECT_RADIUS;
        let gain = CONST.SCORE_PER_LAND;
        if (perfect) {
          this.combo += 1;
          gain += CONST.PERFECT_BASE * this.combo;
          this._popCombo(this.combo);
          this._burstParticles(targetScreen.x, targetScreen.y - target.height * 0.2, '#ffd23f', 18);
          this.audio.perfect();
        } else {
          this.combo = 0;
          this.audio.land();
        }
        this.score += gain;
        this._updateHUD();
        // 补充平台
        if (this.platforms.length - this.currentIdx < 5) this._spawnNext();
        this.state = STATE.READY;

        // 落到玻璃平台：触发自动连续跳跃（仅首次落上时触发，避免连跳途中再次落 glass 递归叠加）
        if (target.type === 'glass' && this.autoJumpsLeft === 0) {
          this._startAutoJumps();
          this._popGlass();
          this._burstParticles(targetScreen.x, targetScreen.y - target.height * 0.2, '#a8e8ff', 24);
        }
      } else {
        // 失败：开始掉落动画
        this.autoJumpsLeft = 0;
        this.autoTimer = 0;
        this._burstParticles(frogScreen.x, frogScreen.y, '#3f9a3a', 14, 120);
        this.audio.fail();
        this.frog.startFalling();
        this.fallTimer = 0;  // 掉落后延迟结束的时间
        this.state = STATE.FALLING;
      }
    }

    _gameOver() {
      this.state = STATE.GAMEOVER;
      const newBest = this.score > this.best;
      if (newBest) { this.best = this.score; Storage.set(this.best); }
      this.elFinalScore.textContent = this.score;
      this.elFinalJumps.textContent = this.jumps;
      this.elFinalBest.textContent = this.best;
      this.elOverTitle.textContent = newBest ? '新纪录！' : '游戏结束';
      this.elOverTitle.classList.toggle('new-best', newBest);
      const msgs = newBest
        ? ['青蛙之王，名不虚传！', '森林新传说诞生了', '这弹跳力，绝了']
        : ['差一点点！', '蓄力再准一点试试', '青蛙需要多练习', '再跳一次吧'];
      this.elOverMsg.textContent = Util.pick(msgs);
      this._updateHUD();
      // 延迟显示，让失败粒子先飞
      setTimeout(() => this.overScreen.classList.remove('hidden'), 480);
    }

    /* ---------- HUD / 特效 ---------- */
    _updateHUD() {
      this.elScore.textContent = this.score;
      this.elJumps.textContent = this.jumps;
      this.elBest.textContent = this.best;
    }
    _popCombo(combo) {
      const txt = combo >= 2 ? `完美 ×${combo}` : '完美！';
      this.elComboPop.textContent = txt;
      this.elComboPop.classList.remove('show');
      // 触发动画
      void this.elComboPop.offsetWidth;
      this.elComboPop.classList.add('show');
      clearTimeout(this._comboTimer);
      this._comboTimer = setTimeout(() => this.elComboPop.classList.remove('show'), 900);
    }
    // 玻璃平台触发：冰蓝色提示 + 自动连跳次数
    _popGlass() {
      const txt = `玻璃平台！自动连跳 ×${CONST.GLASS_AUTO_JUMPS}`;
      this.elComboPop.textContent = txt;
      this.elComboPop.classList.add('glass');
      this.elComboPop.classList.remove('show');
      void this.elComboPop.offsetWidth;
      this.elComboPop.classList.add('show');
      clearTimeout(this._comboTimer);
      this._comboTimer = setTimeout(() => {
        this.elComboPop.classList.remove('show');
        this.elComboPop.classList.remove('glass');
      }, 1100);
    }
    _burstParticles(x, y, color, count, speed = 160) {
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = Util.rand(speed * 0.4, speed);
        this.particles.push(new Particle(
          x, y,
          Math.cos(ang) * sp, Math.sin(ang) * sp - 40,
          Util.rand(0.4, 0.9), color, Util.rand(2, 4.5)
        ));
      }
    }

    /* ---------- 渲染 ---------- */
    _render() {
      const { W, H } = this;
      this.renderer.drawBackground(W, H, this.time, this.camera.ox);
      this.renderer.drawFireflies(W, H, this.time);

      // 平台：从远到近排序绘制（worldX+worldY 越大越近）
      const sorted = this.platforms.slice().sort((a, b) =>
        (a.worldX + a.worldY) - (b.worldX + b.worldY));
      sorted.forEach(p => {
        this.renderer.drawShadow(this.camera, p.worldX, p.worldY, p.topR * CONST.TW * 0.7, 0.28);
        this.renderer.drawPlatform(this.camera, p);
      });

      // 目标平台中心提示圈（READY/CHARGING 时）
      if ((this.state === STATE.READY || this.state === STATE.CHARGING) && this.platforms[this.currentIdx + 1]) {
        this.renderer.drawPerfectMarker(this.camera, this.platforms[this.currentIdx + 1]);
      }

      // 青蛙阴影：仅在跳跃过程中显示；青蛙升高时影子变小变淡，降落时变大变深
      if (this.state === STATE.JUMPING) {
        const heightAbove = Math.max(0, this.frog.z - this.frog.baseZ);
        const hf = Util.clamp(heightAbove / CONST.JUMP_HEIGHT_MAX, 0, 1);
        const shadowR = 16 * (1 - hf * 0.6);   // 最高时缩到 40%
        const shadowA = 0.3 * (1 - hf * 0.7);  // 最高时淡到 30%
        this.renderer.drawShadow(this.camera, this.frog.worldX, this.frog.worldY, shadowR, shadowA);
      }
      // 青蛙
      this.renderer.drawFrog(this.camera, this.frog);

      // 粒子
      this.renderer.drawParticles(this.particles);

      // 蓄力条 & 落点提示
      if (this.state === STATE.CHARGING) {
        // 蓄力过程中实时显示预计落点辅助线（含落点靶心）
        if (this.aimLineEnabled) {
          this.renderer.drawAimArc(this.camera, this._calcJumpTrajectory(this.frog.charge));
        }
        this.renderer.drawChargeBar(W, this.frog.charge, true);
      }
    }
  }

  /* ===================== 启动 ===================== */
  window.addEventListener('load', () => {
    window.__game = new Game();
  });
})();
