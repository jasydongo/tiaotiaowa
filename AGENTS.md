# 跳跳蛙 (Jumping Frog) 项目上下文文档

## 项目概述

跳跳蛙是一个微信"跳一跳"玩法的 WEB 小游戏，采用 HTML5 Canvas 2D + 等距斜投影伪 3D 技术，无任何第三方依赖。游戏主题为深绿森林夜景，青蛙在木桩、蘑菇、石台、荷叶、树桩高塔之间蓄力跳跃，落在平台中心可触发完美连击加倍得分。

### 核心玩法
- 按住蓄力，松开起跳，蓄力时间决定跳跃距离和高度
- 落在下一个平台得 1 分，镜头自动前移
- 落在平台中心圈内触发完美连击，获得额外加分奖励
- 落空、掉下或跳过头则游戏结束
- 本地自动记录历史最高分

### 特殊机制
- 玻璃平台：每 30 次跳跃出现一次，落上触发 3 次自动连跳
- 完美连击：连击数越高奖励越大（完美奖励 = 2 × 连击数）
- 辅助线：显示蓄力时的落点预测轨迹

## 技术栈

### 前端技术
- **HTML5 Canvas 2D**：核心游戏渲染
- **纯原生 JavaScript**：无框架依赖，单文件模块化设计
- **Web Audio API**：实时合成音效和背景音乐
- **CSS3**：UI 界面和 SVG 青蛙动画
- **等距斜投影**：实现伪 3D 效果

### 关键技术实现
- **伪 3D 渲染**：等距斜投影（isometric），平台为顶面菱形 + 双侧面的立体方块
- **物理系统**：蓄力曲线 → 抛物线跳跃 `z = 4·h·t·(1−t)`，落地挤压回弹形变
- **镜头跟随**：指数平滑跟随（damp，帧率无关）
- **碰撞检测**：青蛙与目标平台投影到屏幕后的距离对比
- **粒子系统**：完美连击金色粒子、背景萤火虫（lighter 混合发光）

## 项目结构

```
jumpfrog/
├── index.html          # 页面骨架 + Canvas + UI 浮层 + SVG 青蛙吉祥物
├── css/
│   └── style.css       # 全屏布局、UI 浮层、SVG 青蛙 CSS 动画
├── js/
│   └── game.js         # 全部游戏逻辑（模块化，单文件 1455 行）
├── favicon.svg         # 网站 favicon
└── README.md           # 项目说明文档
```

## 核心代码架构

### JavaScript 模块结构 (`js/game.js`)

```javascript
// 全局常量
CONST {
  TW, TH,              // 等距投影参数
  PLATFORM_TYPES,      // 平台类型：stump, mushroom, stone, leaf, tower, glass
  CHARGE_RATE,         // 蓄力速率
  JUMP_DIST_MAX,       // 最大跳跃距离
  PERFECT_RADIUS,      // 完美判定半径
  GLASS_INTERVAL,      // 玻璃平台间隔（30 次）
  GLASS_AUTO_JUMPS     // 玻璃平台触发连跳次数（3 次）
}

// 核心类
Input          // 统一输入处理（鼠标/触摸/空格）
Audio          // Web Audio 合成音效 + 背景音乐
Storage        // localStorage 最高分读写
Platform       // 平台对象（6 种类型 + 物理属性）
Frog           // 青蛙角色（蓄力/跳跃/形变/待机动画）
Particle       // 粒子效果
Firefly        // 背景萤火虫
Camera         // 镜头跟随 + 世界→屏幕投影
Renderer       // 渲染器（背景/平台/青蛙/粒子/辅助线）
Game           // 游戏状态机 + 主循环
```

### 游戏状态机

```javascript
STATE = {
  READY: 'ready',        // 准备状态（可蓄力）
  CHARGING: 'charging',  // 蓄力中
  JUMPING: 'jumping',    // 跳跃中
  GAMEOVER: 'gameover'   // 游戏结束
}
```

### 平台类型与特性

| 类型 | 特点 | 高度 | 弹性 |
|------|------|------|------|
| stump | 木桩，年轮纹理 | 64 | 无 |
| mushroom | 蘑菇，白点装饰 | 30 | 0.6 |
| stone | 石台，苔藓点缀 | 22 | 无 |
| leaf | 荷叶，放射状叶脉 | 12 | 0.8 |
| tower | 树桩高塔，高而窄 | 96 | 无 |
| glass | 玻璃平台，半透明辉光 | 34 | 无 |

### 核心游戏循环

```javascript
_loop(now) {
  dt = 计算帧时间
  _update(dt)     // 更新游戏状态
  _render()       // 渲染画面
  requestAnimationFrame(_loop)
}

_update(dt) {
  // 状态机处理
  if (CHARGING) frog.charging(dt)
  if (JUMPING) {
    if (frog.updateJump(dt)) _resolveLanding()
  }
  
  // 自动连跳处理
  if (READY && autoJumpsLeft > 0) {
    autoTimer -= dt
    if (autoTimer <= 0) _performAutoJump()
  }
  
  // 粒子、镜头、动画更新
  particles.update(dt)
  camera.follow(frog)
  frog.updateIdle(dt)
}
```

## 构建和运行

### 运行方式

**最简单方式**：直接双击 `index.html` 用浏览器打开即可。

**本地服务器（推荐）**：
```bash
# Python 3
python -m http.server 8000

# Node.js
npx http-server -p 8000
```

然后访问 `http://localhost:8000`

### 无构建流程
- 不需要 npm install、webpack、vite 等构建工具
- 直接修改代码后刷新浏览器即可看到效果
- 适合快速原型开发和教学演示

## 开发规范

### 代码风格
- 采用模块化类结构设计，每个类负责单一功能
- 使用严格模式 `'use strict'`
- 物理计算与渲染分离，便于维护
- 注释清晰，关键算法有详细说明

### 调试建议
- 使用浏览器开发者工具的 Canvas 调试功能
- 可在 `CONST` 中修改物理参数快速调整游戏手感
- 使用 `aimLineEnabled` 开关调试落点预测算法

### 扩展方向
- 添加新的平台类型：在 `CONST.PLATFORM_TYPES` 和 `Platform` 类中扩展
- 调整游戏难度：修改 `PLATFORM_MIN_GAP`、`PLATFORM_MAX_GAP` 等参数
- 自定义音效：在 `Audio` 类中调整音调和频率
- 添加新的视觉效果：在 `Renderer` 类中扩展粒子系统

## 常见问题

### 性能优化
- Canvas 使用 DPR 高清渲染（上限 ×2）
- 粒子系统有生命周期管理，自动清理过期粒子
- 背景萤火虫使用对象池复用

### 浏览器兼容性
- 使用现代浏览器（Chrome、Firefox、Safari、Edge）
- Web Audio API 需要用户交互后才能启动
- 触摸事件支持移动端操作

### 数据存储
- 最高分存储在 `localStorage`，键名为 `tiao_tiao_wa_best`
- 数据持久化，关闭浏览器后仍然保留

## 游戏配置参数

### 物理参数（可调整）
```javascript
CHARGE_RATE: 1.2           // 蓄力增长速率
JUMP_TIME_MIN: 0.32        // 最小跳跃时间
JUMP_TIME_MAX: 1.15        // 最大跳跃时间  
JUMP_DIST_MAX: 7.0         // 最大跳跃距离
JUMP_HEIGHT_MAX: 150       // 最大跳跃高度（像素）
PERFECT_RADIUS: 7          // 完美判定半径（屏幕像素）
```

### 难度参数
```javascript
PLATFORM_MIN_GAP: 2.0      // 平台间最小距离
PLATFORM_MAX_GAP: 7.0      // 平台间最大距离
PLATFORM_MAX_OFFSET: 2.2   // 左右最大偏移
GLASS_INTERVAL: 30         // 玻璃平台间隔
GLASS_AUTO_JUMPS: 3        // 连跳次数
```

## 输入控制

| 设备 | 蓄力操作 | 起跳操作 |
|------|----------|----------|
| 桌面 | 鼠标按住 / 空格键 | 松开鼠标 / 松开空格键 |
| 移动端 | 手指按住屏幕 | 松开手指 |

### UI 按钮
- 🔊 音效开关：切换 Web Audio 音效与背景音乐
- 🎯 辅助线开关：显示/隐藏蓄力时的落点预测轨迹

## 音效系统

### 音效类型
- `charge()`：蓄力音效
- `jump()`：跳跃音效  
- `land()`：落地音效
- `perfect()`：完美连击音效
- `fail()`：失败音效

### 背景音乐
- C 大调音阶自动播放（C4-C5）
- 每 400ms 播放一个音符
- 可通过音效开关控制

## 视觉设计

### 主题配色
```css
--bg-deep: #0d2b1a      // 深绿森林背景
--moss: #2f7d4f         // 苔藓绿
--leaf: #6fd08a         // 鲜绿
--amber: #ffd23f        // 琥珀色（完美连击）
--cream: #f3ffe8        // 米白（文字）
```

### 视觉效果
- 深绿森林夜景主题
- 层叠树影视差背景
- 漂浮萤火虫粒子（发光效果）
- 林冠月光光晕
- 地面雾气渐变
- 玻璃平台特殊辉光效果

## 总结

跳跳蛙是一个优秀的纯前端游戏项目，展示了如何用原生技术实现复杂的游戏逻辑和视觉效果。项目结构清晰，代码质量高，是学习 Canvas 游戏开发和理解游戏物理引擎的优秀案例。

**项目特色**：
- ✨ 零依赖，纯原生实现
- 🎮 精准的物理模拟和碰撞检测
- 🎨 精美的伪 3D 视觉效果
- 🎵 实时合成的音效系统
- 📱 完美的跨设备支持
- 🏆 完整的游戏循环和状态管理