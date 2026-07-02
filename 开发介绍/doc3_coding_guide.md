# 指尖博弈 — 代码规范与开发指南

## ⚠️ 核心原则：不改底层，用钩子

**最重要的一条规则：** 新增角色或功能时，**绝对不允许**在 `GameEngine.hx`、`TurnManager.hx`、`model/Player.hx` 中加入任何角色特判（`if name == "xxx"` 或 `Std.isOfType(actor, SomeCharacter)`）。

所有角色特定逻辑必须通过**重写 Player 的虚方法钩子**实现，在角色自己的 `.hx` 文件中完成。

**例外情况**：只有当现有钩子体系完全无法覆盖某个全新机制时，才允许修改底层文件，且必须是添加新钩子，不是加角色特判。

---

## 一、项目结构

```
根目录/
├── GameEngine.hx              # 核心引擎（禁止随意修改）
├── TurnManager.hx             # 回合管理（禁止随意修改）
├── Main.hx                    # 入口 + 前端接口（@:keep @:expose）
├── build.hxml                 # Haxe 编译配置（→ main.js，-dce full）
├── main.js                    # Haxe 编译产物（不直接编辑）
├── index2.html                # 2v2 前端主页面
├── network.js                 # 联机 WebSocket 客户端层
├── server.js                  # Node.js 联机服务端（房间管理 + 消息中转）
├── package.json               # Node.js 依赖（ws 库）
│
├── model/
│   ├── Player.hx              # 玩家基类（新增钩子需谨慎，见第三节）
│   ├── Buff.hx                # Buff 基类
│   ├── Camp.hx                # 阵营枚举（HERO / REBEL）
│   ├── DamageType.hx          # 伤害类型枚举（PHYSICAL / MAGIC / TRUE）
│   ├── HealType.hx            # 回血类型枚举（RECOVERY / SUPPLY）
│   ├── ShieldInstance.hx      # 护盾实例（type + amount + duration）
│   └── ShieldType.hx          # 护盾类型枚举
│
├── buffs/
│   ├── DamageBoostBuff.hx     # 伤害翻倍（双4）
│   ├── ExtraActionBuff.hx     # 额外行动（双8）
│   ├── FrozenBuff.hx          # 冰冻
│   ├── InvincibleBuff.hx      # 无敌（双1、大乔复活甲）
│   ├── PoisonBuff.hx          # 中毒
│   ├── ReflectBuff.hx         # 反弹盾（双5）
│   └── ThunderRageBuff.hx     # 雷霆之怒（法师）
│
├── character/
│   ├── CharacterRegistry.hx   # 角色注册中心
│   ├── Player.hx              # （同 model/Player.hx 的引用，部分目录结构）
│   ├── XiaoQiao.hx            # 小乔（HP: 360）
│   ├── ZangShi.hx             # 藏师（HP: 660）
│   ├── FaShi.hx               # 法师（HP: 160）
│   ├── SunWuKong.hx           # 孙悟空（HP: 260）
│   ├── DaQiao.hx              # 大乔（HP: 120）
│   ├── RenZhe.hx              # 忍者（HP: 300）
│   ├── ZhangFei.hx            # 张飞（HP: 560）
│   └── YinYangShi.hx          # 阴阳师（HP: 240）
│
├── js/                        # 2v2 前端 JS 模块（浏览器全局作用域加载）
│   ├── game2-core.js          # 点击状态机、攻击流程、帮抗检测
│   ├── game2-state.js         # 全局状态G、阵容管理、抗伤位、攻击目标解析
│   ├── game2-render.js        # 渲染（render2/refreshHandStyles2）、角色图片
│   ├── game2-dialogs.js       # 所有弹窗（帮抗、孙悟空[0,2]、蛋糕、大乔抢血）
│   └── game2-online.js        # 联机协调层（操作同步、权限控制）
│
├── image/                     # 角色立绘（角色名.png，如 小乔.png）
├── music1/                    # BGM 文件夹（.mp3）
└── ai/                        # AI 决策系统（独立模块）
```

> **重要**：`main.js` 被 Haxe 的 IIFE 包裹，`GameEngine` 等类是 IIFE 内部局部变量，**外部 JS 无法直接访问**。如需从 JS 侧调用 Haxe 的功能，必须通过 `Main` 类的 `@:keep` 静态方法暴露（如 `Main.setTankResolver(fn)`、`Main.invokeAction(...)` 等）。

---

## 二、添加新角色的正确流程

### 步骤1：创建角色文件

在 `character/` 目录新建 `MyHero.hx`：

```haxe
package character;
import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;

class MyHero extends Player {
    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 200, camp); // HP=200
    }

    // 重写需要的钩子方法（不重写的保持基类行为）
}
```

### 步骤2：注册角色

在 `character/CharacterRegistry.hx` 的 `init()` 函数里加一行：

```haxe
register("myhero", "🗡️ 我的英雄 (200HP)", 200,
    (id, camp) -> new MyHero(id, "我的英雄", camp));
```

**就这两步，完成。不需要改其他任何文件。**

### 步骤3：添加角色立绘（可选）

将角色图片放入 `image/` 目录，文件名为角色 `name` 字段对应的名字（如 `我的英雄.png`）。

在 `js/game2-render.js` 的 `_AVATAR_MAP` 对象里加一条映射：
```js
'我的英雄': '我的英雄'  // key=角色name，value=image/目录下的文件名（不含.png）
```

---

## 三、Player.hx 可用的钩子方法

以下是所有可重写的钩子，**选择需要的重写即可，不需要的不用写**：

### 伤害/回血计算钩子

```haxe
// 修改自己的输出伤害（如小乔×1.5，张飞模态加成）
override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
    if (type == PHYSICAL) return Std.int(baseAmount * 1.5);
    return baseAmount;
}

// 修改自己的回血量（如小乔×1.5，藏师×2.5）
// ⚠️ 重要：必须先调 super.calculateFinalHeal(baseAmount, type)
//    基类里处理了坦脆流坦克加成（×1.5），子类在基类结果上再乘自己的倍率
//    才能保证叠乘正确（如小乔坦克 = ×1.5×1.5 = ×2.25）
override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
    var base = super.calculateFinalHeal(baseAmount, type); // 含坦克加成
    return Math.ceil(base * 1.5);
}

// 修改自己受到伤害的量（如藏师物理减半，张飞差值免伤）
override public function handleIncomingDamage(attacker:Player, amount:Int, type:DamageType):DamageResult {
    if (type == PHYSICAL) amount = Std.int(amount / 2);
    return super.handleIncomingDamage(attacker, amount, type);
}
```

### 事件触发钩子

```haxe
// 自己造成伤害后（小乔补给、忍者追加法伤）
override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
    if (type == PHYSICAL && actualDamage > 0) {
        engine.applyRawHeal(this, actualDamage, SUPPLY);
    }
}

// 自己回血后（小乔回血时打人）
override public function onAfterHeal(actualHeal:Int, type:HealType, engine:GameEngine):Void {
    var enemy = engine.findEnemyTarget(this);
    if (enemy != null) engine.applyRawDamage(this, enemy, actualHeal, PHYSICAL);
}

// 回合结束时（张飞补给/怒气/狂暴倒计时）
override public function onTurnEnd() {
    super.onTurnEnd(); // ⚠️ 必须调用，处理中毒/护盾等基础结算
    engine.applyRawHeal(this, 10, SUPPLY, false);
}

// 大回合结束时（藏师蛋糕计数重置）
override public function onBigRoundEnd():Void {
    cakeEventsThisRound = 0;
}

// 碰手结算完毕（孙悟空检查0增益结束）
override public function onAfterTouchResolved():Void {
    checkZeroComboReset();
}
```

### 全场事件监听钩子

```haxe
// 全场任何人回血时（孙悟空更新y，大乔抢夺判断，张飞怒气）
override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {}

// 全场任何人获盾时（藏师蛋糕）
override public function onAnyShieldGained(target:Player, isFromSkill:Bool, engine:GameEngine):Void {}

// 全场任何人输出物伤时（孙悟空更新x）
override public function onAnyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType, engine:GameEngine):Void {}

// 全场毒伤扣血时（忍者回血）
override public function onAnyPoisonTick(victim:Player, actualDamage:Int, engine:GameEngine):Void {
    if (victim == this) return;
    engine.applyRawHeal(this, actualDamage, SUPPLY, true);
}

// 全场解毒时（忍者回20）
override public function onAnyPoisonCleared(victim:Player, engine:GameEngine):Void {
    if (victim == this) return;
    engine.applyRawHeal(this, 20, SUPPLY, true);
}

// 雷霆扣血时（法师回血）
override public function onAnyThunderTick(caster:Player, victim:Player, actualDamage:Int, engine:GameEngine):Void {
    if (caster != this) return;
    engine.applyRawHeal(this, actualDamage, SUPPLY, true);
}
```

### 特殊机制钩子

```haxe
// 覆盖默认组合效果（孙悟空的[0,2]）
override public function tryOverrideComboEffect(comboKey:String, target:Player, engine:GameEngine):Bool {
    if (comboKey != "0_2") return false;
    // 执行自定义效果...
    return true; // 返回true表示已处理，不走默认逻辑
}

// 进入/退出0组合上下文（法师激活物伤翻倍）
override public function onEnterZeroComboContext():Void { _inZeroCombo = true; }
override public function onExitZeroComboContext():Void { _inZeroCombo = false; }

// HP归零时复活机会（大乔复活甲）
override public function tryRevive(engine:GameEngine):Bool {
    if (hasRevived) return false;
    hasRevived = true;
    hp = 1;
    addBuff(new InvincibleBuff(2));
    return true;
}

// 是否跳过本回合的0寿命递减（孙悟空[0,2]延寿）
override public function shouldSkipZeroTurnsDecrement():Bool {
    if (skipNextZeroDecrease) { skipNextZeroDecrease = false; return true; }
    return false;
}
```

### 前端自描述钩子

```haxe
// 角色卡片下方显示的特殊状态（如孙悟空的x/y值）
override public function getCustomDisplay():String {
    return '🐒 x = <b>${x}</b> | y = <b>${y}</b>';
}

// 角色卡片下方的操作按钮（如藏师的蛋糕按钮）
override public function getCustomActions():Array<CustomAction> {
    if (cakes < 3) return [];
    return [{ label: "使用蛋糕", color: "#eb2f96", enabled: true,
              onClickJS: "openCakeDialog(__IDX__)" }];
}

// 前端统一动作派发入口（替代在Main.hx里写专用方法）
override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
    if (actionName == "myAction") {
        // 执行动作...
        return "成功";
    }
    return super.handleAction(actionName, params, engine);
}
```

---

## 四、GameEngine 可用的 API

角色代码中应调用这些接口，**不要直接操作 Player 的 hp 字段**：

```haxe
// 造成伤害（走calculateOutputDamage + 事件广播 + 钩子）
engine.applyDamage(actor, target, baseAmount, DamageType.PHYSICAL);

// 造成原始伤害（不走calculate，不广播，用于钩子内防套娃）
engine.applyRawDamage(actor, target, amount, DamageType.MAGIC);

// 回血（走calculateFinalHeal + 事件广播 + 钩子）
engine.applyHeal(actor, baseAmount, HealType.RECOVERY);

// 原始回血（不走calculate，isFromSkill=true时不广播heal事件）
engine.applyRawHeal(actor, amount, HealType.SUPPLY, true);

// 添加护盾（统一入口，会触发notifyShieldEvent + 坦克加成）
engine.applyShield(actor, ShieldType.PHYSICAL, amount, duration);

// 找到当前行动者的第一个敌方目标（走 tankResolver，遵循抗伤位规则）
var enemy = engine.findEnemyTarget(actor);

// 广播输出伤害事件（让孙悟空更新x，不走实际伤害流程）
engine.notifyOutputDamage(actor, target, outputDamage, DamageType.PHYSICAL);

// 给坦脆流坦克施加永久加成（游戏开始时由JS调用）
engine.applyTankFormationBuff(playerIdx);

// 设置 tankResolver（只能通过 Main.setTankResolver，不能直接操作GameEngine）
Main.setTankResolver(fn);  // JS侧调用
```

### 帮抗相关 API（三步走）

```haxe
// 步骤1：攻击前快照 victim 的防御状态
engine.snapshotHelpTankVictim(victim);

// 步骤2：攻击后冻结伤害记录（防止被后续handleTouch清空）
engine.captureHelpTankDamage();

// 步骤3：确认帮抗时调用（恢复victim + helper承伤×1.5）
engine.resolveHelpTank(helperIdx);
```

---

## 五、回血类型使用规范

| 场景 | 类型 | 原因 |
|------|------|------|
| 角色被动：实际打了多少伤害回多少血 | **SUPPLY** | 不被大乔抢，不解毒 |
| 角色主动：使用技能回血（孙悟空[0,2]、张飞模态③、藏师蛋糕） | **RECOVERY** | 会被大乔抢，可解毒 |
| 忍者毒伤/法伤被动回血 | **SUPPLY** | 被动触发，按实际伤害 |
| 法师雷霆回血 | **SUPPLY** | 被动触发，按实际伤害 |
| 小乔打人补给 | **SUPPLY** | 被动触发，按实际伤害 |
| 大乔抢夺获得的血 | **SUPPLY** | 不能被再次抢夺 |

**套娃防护**：钩子内调用 `applyRawHeal/applyRawDamage`（不触发事件），或使用 `_inExtraEffect` 守卫变量防止无限循环。

---

## 六、坦脆流实现要点

### Haxe 侧
- `Player.tankFormationBonus:Bool`：坦克加成标志，`applyTankFormationBuff()` 写入
- `Player.calculateFinalHeal`：基类先乘 ×1.5（若 `tankFormationBonus`），子类在此基础上再乘角色倍率
- `GameEngine.applyShield`：检查 `actor.tankFormationBonus`，自动升级护盾类型/厚度

### JS 侧（game2-state.js）
- `G.formation`：`{ hero: 'dual_half'|'tank_carry', rebel: 'dual_half'|'tank_carry' }`
- `G.tankIdx`：`{ hero: playerIdx, rebel: playerIdx }` ——抗伤位/坦克的玩家索引
- `G.tankTarget`：`{ hero: 'carry'|'tank', rebel: 'carry'|'tank' }` ——坦克当前选择打谁
- `getActualTarget(intendedTargetIdx, bypassTankRule)`：按阵容规则返回实际受伤目标
- `setupTankResolver()`：通过 `Main.setTankResolver(fn)` 设置被动技能的目标解析

> ⚠️ `Main.engine.constructor.tankResolver` 无效！因 Haxe 的 IIFE 包裹，`Main.engine.constructor` 是 `Object` 而非 `GameEngine`。必须用 `Main.setTankResolver(fn)`。

---

## 七、联机架构要点

### 服务端（server.js）
- 纯消息中转，不跑游戏逻辑
- 房间管理：`rooms[code] = { p0, p1 }`，seat 0 = HERO，seat 1 = REBEL
- HTTP 静态文件托管（含 `music1/` mp3 文件，`/api/music` 接口）
- `decodeURIComponent(url)` 处理中文/特殊字符文件名

### 客户端（game2-online.js + network.js）
- `ONLINE.active`：是否联机模式
- `ONLINE.seat`：0=HERO，1=REBEL
- `ONLINE.isMyTurn()`：当前是否轮到我方操作
- 操作同步：本地执行后调 `ONLINE.sendAction(payload)`；收到远端操作后执行但不再回发
- 权限控制：弹窗（帮抗/大乔抢血/蛋糕）联机时只对己方阵营显示，自定义按钮只对己方渲染

---

## 八、常见错误

### ❌ 在底层文件加角色特判
```haxe
// 禁止！破坏架构
if (Std.isOfType(actor, character.XiaoQiao)) { ... }
```

### ✅ 角色重写钩子
```haxe
// 在 XiaoQiao.hx 里重写对应钩子
override public function tryOverrideComboEffect(...) { ... }
```

---

### ❌ calculateFinalHeal 不调 super
```haxe
// 错误：跳过基类的坦克加成
override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
    return Math.ceil(baseAmount * 2.5); // 藏师坦克时少乘×1.5
}
```

### ✅ 必须先调 super
```haxe
override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
    var base = super.calculateFinalHeal(baseAmount, type); // 含坦克加成
    return Math.ceil(base * 2.5);
}
```

---

### ❌ 直接操作 HP
```haxe
target.hp -= 50; // 禁止
```

### ✅ 走接口
```haxe
engine.applyDamage(this, target, 50, PHYSICAL);
```

---

### ❌ 从 JS 直接访问 GameEngine 静态变量
```js
GameEngine.tankResolver = fn; // 无效，GameEngine 在 IIFE 内，外部访问不到
Main.engine.constructor.tankResolver = fn; // 同样无效，constructor 是 Object
```

### ✅ 通过 Main 暴露的方法
```js
Main.setTankResolver(fn); // ✓ 正确，@:keep 方法，内部赋值到 GameEngine.tankResolver
```

---

## 九、编译与运行

```bash
# Haxe 编译（项目根目录）
haxe build.hxml

# 本地启动联机服务器
node server.js
# → 访问 http://localhost:3000
```

```
# build.hxml
-cp .
-cp ai
-main Main
-js main.js
-dce full
```

---

## 十、新窗口快速上手

1. 阅读本文档了解架构和规范
2. 阅读 `doc1_game_rules.md` 了解游戏规则（角色技能、2v2阵容）
3. 阅读 `doc2_advanced_strategy.md` 了解各角色策略
4. 上传需要修改的具体 `.hx` 文件或 `js/` 文件
5. 说明要做的事情

**记住：所有角色逻辑在角色文件里，不改底层。JS 访问 Haxe 内部必须通过 Main 的 @:keep 方法。**
