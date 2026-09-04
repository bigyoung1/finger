# 指尖博弈 — 新窗口交接文档 v2

> 本文档记录截至当前的完整开发状态，新会话直接从这里接手。

> 当前需求与开发规范分别见 `REQUIREMENTS.md`、`DEVELOPMENT.md`；本文件主要保留开发沿革和交接注意事项。

---

## 2026-09-04 接入更新（以实际运行代码为准）

- 当前项目根目录：`D:\haxe\test`，主页面：`index2.html`，本地启动：`node server.js` 后访问 `http://localhost:3000/index2.html`。
- Haxe 改动后必须运行 `haxe build.hxml`；`main.js` 是编译产物，不要手动改。
- 当前共有 13 个角色。角色注册改为编译期自动发现：角色类声明 `@:gameCharacter(...)`，立绘使用 `image/角色中文名.png`，不再手改注册表或头像映射。
- 2v2 目标限制在 `js/game2-state.js#getActualTarget()`；Haxe 被动技能目标通过 `Main.setTankResolver(fn)` 注入，不能从 JS 直接访问 `GameEngine` 静态变量。
- `index2.html` 中 `startGame2` 被多层包装：基础建局、联机同步、AI 控制、阵容写入/坦克加成都在这里串起来。改开局流程时必须按加载顺序检查。
- AI provider 已统一默认使用 `deepseek`：`AI_MODEL_CONFIG`、角色控制下拉默认模型、自战训练、复盘都走 DeepSeek。
- AI key 统一走环境变量：在项目根目录 `.env` 中配置 `DEEPSEEK_API_KEY`。`.env` 不提交，提交 `.env.example` 作为模板。
- `server.js` 已移除 MiniMax、千帆、DeepSeek 的硬编码旧 key。若切换到 MiniMax/千帆，必须分别设置 `MINIMAX_API_KEY` / `QIANFAN_API_KEY`，否则 `/api/ai` 会返回缺少环境变量。
- 静态服务器已改为公开文件白名单，`.env`、Haxe 源码、日志、AI 资料和 `node_modules` 不再能通过 URL 直接下载。
- 明文账号文件 `js/account.txt` 已删除并加入忽略规则；历史中出现过的凭据仍必须在对应平台轮换。

---

## 一、项目概述

**指尖博弈**：基于手指游戏（Chopsticks）改造的 2v2 回合制策略对战游戏。
- 每个玩家有左右两只手（数字 0-9），轮流用己方一只手碰对方一只手，两数相加取余10，凑出特定组合触发技能效果
- 目前有 **13 个可选角色**，支持 2v2 联机、本地和 AI 对战
- 本地运行：`node server.js` → `http://localhost:3000/index2.html`

---

## 二、目录结构

```
test/
├── GameEngine.hx          核心战斗引擎 —— 伤害/回血/组合触发/帮抗
├── TurnManager.hx         回合管理（死亡检测、大回合、冰冻跳过）
├── Main.hx                入口、角色创建、invokeAction 分发
├── build.hxml             Haxe 编译配置（-cp . -main Main -js main.js -dce full）
├── main.js                Haxe 编译产物（不要手动修改）
├── server.js              Node.js 服务器
├── network.js             WebSocket 客户端网络层（4-slot 联机）
├── index2.html            2v2 主战场页面
├── guide.html             新手指南（含互动示例）
├── css/
│   └── game2.css
├── js/
│   ├── game2-render.js    渲染层（HP/手牌/Buff/护盾/VFX差量触发）
│   ├── game2-core.js      核心交互（点击状态机、doAttack2、finishTurn2、帮抗）
│   ├── game2-dialogs.js   所有弹窗（帮抗/孙悟空选目标/大乔抢血/藏师蛋糕/乌鸦诅咒）
│   ├── game2-state.js     抗伤位/坦克/阵容状态管理（G 对象）
│   ├── game2-online.js    联机逻辑（WebSocket，4-slot，charControl）
│   ├── game2-ai.js        AI 对战模块（见 AI 系统章节）
│   └── game2-vfx.js       战斗特效（斩击/加号/护盾/屏幕震动）
├── model/
│   ├── Player.hx / Buff.hx / DamageType.hx / HealType.hx
│   ├── ShieldType.hx / ShieldInstance.hx
├── buffs/
│   ├── PoisonBuff.hx / DamageBoostBuff.hx / ReflectBuff.hx
│   ├── InvincibleBuff.hx / ThunderRageBuff.hx / FrozenBuff.hx
│   ├── ExtraActionBuff.hx / CrowBuff.hx
├── character/
│   ├── CharacterRegistry.hx / CharacterRegistryMacro.hx（编译期自动注册）
│   ├── XiaoQiao.hx / ZangShi.hx / FaShi.hx / SunWuKong.hx
│   ├── DaQiao.hx / RenZhe.hx / ZhangFei.hx / YinYangShi.hx
│   ├── YaYan.hx / ZhaoYun.hx / KungFuPanda.hx
│   └── Yangdali.hx / ShenTouNaiBa.hx
├── ai/
│   ├── knowledge.md       AI 经验知识库（每局复盘自动追加）
│   ├── preTrain.js        离线学习脚本
│   └── skills/            角色专属攻略（每个角色一个 md，含权重+攻略+复盘）
│       ├── 小乔.md / 藏师.md / 法师.md / 孙悟空.md / 大乔.md
│       ├── 忍者.md / 张飞.md / 阴阳师.md / 鸦眼.md / 赵云.md
│       └── 功夫熊猫.md / 神偷奶爸.md
└── log/                   历史对战日志（训练自动保存）
```

---

## 三、本会话完成的主要开发

### 3.1 Bug 修复

| 问题 | 修复方式 |
|------|---------|
| Render 部署 CSS 不加载 | `CSS/` 目录大小写与 HTML 引用不一致，Linux 大小写敏感；改为 `css/` |
| VFX 护盾特效不出现 | 快照字段名 `sc/sa` 与实际 `shieldCount/shieldAmount` 不符，修正 |
| 补给回血（SUPPLY）颜色不区分 | 改为队列模式（`_healQueue`），避免多帧竞态 |
| 中毒被物理打也显示绿色斩击 | 删除"有毒就绿"的错误逻辑，改为 Haxe 侧 `VFX.notifyDamage(idx, type)` 精确通知 |
| 护盾特效位置在卡片中央而非头像 | 改为挂载到 `char-avatar-wrap`，用 `clip-path:inset(0)` 避免图片溢出 |
| 0的"双手全零死亡"错误规则 | 删除所有相关代码（AIThink 权重、knowledge.md、guide.html、skill md） |
| AI 一直凑 [2,2]/[3,3] | 修正权重：`star_2=-25`、`star_3=-25`，低价值双子星主动回避 |
| 大乔不会抢血 | `showStealDialog` AI 路径提到冷却检查之前，直接调 `doSteal` |
| 阴阳师只进阴模态 | 完全重写切换逻辑（见 3.4） |
| 藏师不用蛋糕 | `decideActiveSkills` 加蛋糕使用逻辑 |
| 胜负统计永远 W0 L0 | `winningCamp` 是 Haxe enum 对象，需用 `._hx_name` 比较，不能直接 `=== 'hero'` |
| `AI_DEFAULT_WEIGHTS is not defined` | 变量改名为 `AI_BASE_WEIGHTS` 后未同步更新 `window.AI` 初始化处 |
| 控制下拉选 AI 但游戏不动 | `startGame2` 只看 checkbox，现在也检查 `ctrlSelect` 下拉值 |

### 3.2 新功能：4人联机

- `server.js`：支持每个房间最多 4 个 slot，掉线自动广播 `slotLeft`
- `network.js`：`NET.slotIdx` 范围 0~3，`roomState` 含 `slotNames/slotOccupied/hostSlot`
- `game2-online.js`：`ONLINE.charControl[i]` 表示第 i 个角色由哪个 slot（或 'AI'）控制
  - `isMyTurn()` 根据 `charControl[currentActorIdx] === slotIdx` 判断
  - `handleSlotLeft(N)` 掉线后改为 AI 接管
- `index2.html`：每个角色上方有控制下拉，**所有人都可改**（去掉了仅房主限制），改完广播 `ctrlUpdate`

### 3.3 AI 系统重构（game2-ai.js）

原 `AIThink.hx`、`BattleLearning.hx`、`AIBattleRunner.hx` 三个 Haxe 文件是死代码（2v2 不调用），已全部删除。`Main.hx` 里的对应方法也已删除。

**新 AI 架构（纯 JS）：**

```
render2() → AI.checkAndAct()
  → AI.decide.activeSkills()    // 主动技能（鸦眼灼燃、张飞模态、阴阳师切模、藏师蛋糕）
  → AI.decide.tankPosition()    // 抗伤位决策（有盾优先、血少换人）
  → AI.enumerateLegalActions()  // 枚举合法动作
  → AI.score.evaluate()         // 启发式打分（heuristic + lookahead），取 top-5
  → AI.loadSkill(actor.name)    // 加载角色 skill md（含权重）
  → AI.llm.ask(top4, skill)     // MiniMax 或 DeepSeek 决策（15%概率探索）
  → doAttack2()

战斗结束 → AI.reflectBattle() / AI.train.reflect()
  → DeepSeek 复盘
  → 更新 AI_CHAR_WEIGHTS（胜方强化，败方弱化）
  → 写回各角色 skill md（## 权重 块 + 追加复盘记录）
  → 追加 knowledge.md
```

**自战训练系统（AI.train）：**
- 点"🧠 AI 自战训练"按钮触发
- 每局随机选 4 个角色（上局用过的不重复）
- 按角色特点自动决定阵容（含坦克的用坦脆流）
- 自动帮抗判断（`AI.helpTank.decide`，坦脆流坦克血>20%就帮，双半肉看血量）
- 大乔自动抢血（跳过弹窗直接 `doSteal`）
- 每局结束自动保存日志到 `log/`
- 每 5 局 / 停止时保存权重到各角色 skill md

### 3.4 阴阳师 AI 切换逻辑

按攻略第7条：**有好组合时直接用阴/阳，不切人**

```javascript
if (hasAttackCombo)                       → 切阴（最大化输出）
else if (hasHealCombo && !winning)        → 切阳（最大化回血）
else if (hasHealCombo && winning)         → 切阴（回血变打人）
// 无好组合时：刷盾循环
else if (modal === 'ren')                 → 切阴/阳白嫖护盾
else                                      → 切回人（拿护盾回血+获免伤）
```

### 3.5 角色专属权重系统

**废弃 `weights.json`，改为每个角色 skill md 内嵌权重：**

```markdown
# 小乔攻略

## 权重
{"star_6":85,"zero_combo_heal":75,"star_2":-35}

## 核心定位
...

## 复盘 2026-06-12 ✅ 胜
赢因：...
```

- `AI.loadSkill(name)` 加载时同时解析 `## 权重` 块存入 `AI_CHAR_WEIGHTS[name]`
- 打分时 `getCharWeights(actor.name)` 取角色专属权重（合并基础值）
- 训练复盘后自动重写 `## 权重` 块 + 追加复盘记录
- 修改权重只需编辑对应角色的 md 文件

### 3.6 server.js 新增端点

| 端点 | 功能 |
|------|------|
| `GET /api/knowledge` | 读取 knowledge.md |
| `POST /api/knowledge` | 追加 knowledge.md |
| `GET /api/skill?name=小乔` | 读取角色 skill md |
| `POST /api/skill-weight` | 更新 skill md 的 ## 权重 块 + 追加复盘 |
| `POST /api/log` | 保存训练对战日志到 log/ |
| `POST /api/ai` | 代理 LLM（MiniMax / DeepSeek） |

### 3.7 VFX 修复

- **斩击颜色**：物理红 / 法术紫 / 真实白 / 中毒绿，Haxe 侧精确通知，不再猜测
- **回血加号**：绿色=RECOVERY，黄色=SUPPLY，队列模式不丢失
- **护盾特效**：挂到头像容器（`char-avatar-wrap`），居中显示在角色头像上

### 3.8 guide.html 新手指南

- 完整规则介绍（基础/组合/0规则/伤害类型/状态系统）
- 13 个角色简介
- 2v2规则说明
- **互动示例**：阴阳师 vs 大乔的实际手牌，点击操作可实时演算取余结果

---

## 四、关键系统说明

### 伤害计算流程

```
baseAmount
  → 乌鸦buff加算（CrowBuff，在目标身上）
  → calculateOutputDamage（攻击者乘算）
  → 攻击者增伤Buff（DamageBoostBuff双4，snapshot/restore避免重复消耗）
  → notifyOutputDamage（全场广播，更新孙悟空x）
  → VFX.notifyDamage(targetIdx, 'PHYSICAL'|'MAGIC'|'TRUE')
  → target.handleIncomingDamage → 护盾消耗 → hp扣减
  → actor.onAfterDealtDamage
```

### 帮抗系统

`tryHelpTankOrPause(dmgTargetIdx, fromRemote, penaltyOverride)`

- AI 自战时 `showHelpTankDialog` 被覆盖为自动判断（`AI.helpTank.decide`）
- 坦脆流：坦克帮完血 > 20% 就帮；双半肉：自己血 > 55% 或有盾就帮

### 大乔抢血

- Haxe 层 `DaQiao.onAnyHealHappened` 有 `_stealCooldown` 冷却（每大回合每个 healer 只通知一次）
- AI 控制时跳过 JS 层的冷却，直接 `doSteal`
- 规则：每大回合每个 healer 只能抢一次（设计上的限制，不是 bug）

### 阵容与抗伤位

`G` 对象（`game2-state.js`）：
```javascript
G.formation  = { hero: 'dual_half'|'tank_carry', rebel: ... }
G.tankIdx    = { hero: 0|2, rebel: 1|3 }
```

AI 抗伤位决策：有盾优先抗 → 都没盾血多的抗 → 当前抗伤位血 < 25% 强制换人

---

## 五、回血类型速查

| 角色 | 触发 | 类型 | 走倍率 |
|------|------|------|--------|
| 小乔·补给 | 造成物伤 | SUPPLY | ❌ |
| 小乔·普通回血 | 各种组合 | RECOVERY | ✅ ×1.5 |
| 藏师·蛋糕 | 主动释放 | RECOVERY | ❌ raw |
| 藏师·普通回血 | 各种组合 | RECOVERY | ✅ ×2.5 |
| 法师·雷霆 | 雷霆扣血 | SUPPLY | ❌ raw |
| 孙悟空·[0,2] | 大招 | RECOVERY | ✅（含y） |
| 大乔·打人 | 造成物伤 | RECOVERY | ✅ |
| 大乔·抢夺 | 抢夺 | SUPPLY | ❌ raw |
| 忍者·法伤/毒/解毒 | 各触发 | SUPPLY | ❌ raw |
| 张飞·回合结束 | 行动结束 | SUPPLY | ❌ raw |
| 张飞·模态③ | 造成物伤 | RECOVERY | ❌ raw |

RECOVERY：可解毒、可被大乔抢、更新孙悟空y。SUPPLY 三者均不触发。

---

## 六、鸦眼

HP: 140，高风险高回报输出角色。

- **乌鸦诅咒**：自扣40血，给目标阵营施加乌鸦buff 2大回合（物理/真实+20加算，法术/毒+10）
- **灼燃箭**：toggle，攻击时追加法伤（|双手和差|×10），鸦眼SUPPLY补给等量，自扣60血
- **魔王剑**：消耗6乌鸦，需灼燃开启，法伤×2，行动结束扣150血

AI 策略：HP>70 开灼燃，有乌鸦6个且HP>180 开魔王剑，优先凑 [0,x] 攻击组合

---

## 七、AI 系统 skill md 格式

每个角色的 `ai/skills/角色名.md` 格式：

```markdown
# 角色名攻略

## 权重
{"star_6":85,"zero_combo_atk":80,"star_2":-35}

## 核心定位
...攻略内容...

## 复盘 2026-06-12 ✅ 胜（vs 法师+忍者）
赢因：...
```

权重 key 含义（完整列表见 `game2-ai.js` 的 `AI_BASE_WEIGHTS`）：
- `star_N`：凑双子星 [N,N] 的激励（负值=主动回避）
- `zero_combo_atk/heal/7/shield`：完成对应 0 组合的激励
- `build_zero`：凑出 0 的激励
- `six_heal`：[x,6] 单手回血激励
- `kill_bonus`：击杀激励
- `give_star_N`：帮对方凑双子星的惩罚（负值）
- 角色专属：`mage_zero_atk`、`wukong_02`、`ninja_7`、`zhangfei_diff`、`daqiao_evolve`

---

## 八、注意事项

1. **Haxe DCE**：从 JS 调用的 Haxe 方法必须加 `@:keep`（已踩坑：`interceptAttackForDialog`、`canReceiveHelpTank`）
2. **编译**：修改任何 `.hx` 文件后必须 `haxe build.hxml`，JS 文件直接修改即生效
3. **`winningCamp` 是 enum 对象**：比较时用 `winner._hx_name.toUpperCase() === 'HERO'`，不能直接 `=== 'hero'`
4. **`game2-ai.js` 放 `js/` 目录**（不是 `ai/`），`index2.html` 引用的是 `js/game2-ai.js`
5. **CSS 目录**：服务器上是 `css/`（小写），`index2.html` 引用也是 `css/game2.css`
6. **Render 部署**：`knowledge.md` 和 skill md 每次重新部署会重置，务必 commit 进 git
7. **张飞模态2第二刀**不触发帮抗弹窗（在 Haxe 钩子里执行，JS 层无感知）
8. **大乔抢血冷却**：Haxe 层有同一大回合同 healer 只通知一次的设计，这是有意为之（非 bug）

---

## 九、常用命令

```bash
# 编译 Haxe
cd test && haxe build.hxml

# 本地运行
cd test && node server.js
# 浏览器: http://localhost:3000/index2.html

# 设置 API Key（Windows PowerShell）
$env:MINIMAX_API_KEY="你的key"
$env:DEEPSEEK_API_KEY="你的key"
node server.js
```

---

## 十、游戏规则速查

**0机制**：碰出0 → 启动2回合倒计时，归零后强制用0手行动；双手全0时强制用0手；对方双手全0则跳过但状态照常结算。0 **没有死亡惩罚**，持有0是优势（0组合收益极高）。

**组合优先级**：[0,0]真伤 > [9,9]爆发 > [7,7]毒链 > 其他双子星 > 0组合 > [x,6] > 普通攻击

**伤害类型**：物理（物理盾抵）/ 法术（法术盾抵）/ 真实（穿透一切）

本目录的当前文档入口为 `REQUIREMENTS.md`、`DEVELOPMENT.md` 和本交接记录。更细的实现细节以当前代码为准：
- 规则/结算：`GameEngine.hx`、`TurnManager.hx`、`model/Player.hx`
- 角色技能：`character/*.hx` 与 `character/CharacterRegistry.hx`
- 2v2 前端：`index2.html`、`js/game2-state.js`、`js/game2-core.js`
- AI 决策：`js/game2-ai.js`、`ai/skills/*.md`
