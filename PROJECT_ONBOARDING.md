# 指尖博弈 — 项目快速接入文档（供新 AI 会话使用）

> 把这个文档的内容全部粘贴给新窗口，配合关键代码文件即可快速接入。

---

## 项目概述

**指尖博弈**：Haxe 编译到 JS 的回合制数字对战游戏，运行在浏览器。  
**核心玩法**：每人有左右手两个数字(0-9)，轮流选己方一只手碰对方一只手，两数相加%10 更新到己方手上，触发不同的技能组合效果，将对方 HP 打到0获胜。  
**当前状态**：1v1 完整可玩，8个英雄+1沙包，AI自动对战+进化学习系统，正在准备做2v2。

---

## 目录结构

```
根目录/
├── GameEngine.hx          # 核心引擎（伤害/回血/护盾/事件广播）
├── TurnManager.hx         # 回合管理（轮转/大回合/冰冻跳过/胜负判定）
├── Main.hx                # 入口+前端接口（render/invokeAction/AI对战入口）
├── build.hxml             # haxe -cp . -cp ai -main Main -js main.js -dce full
├── index.html             # 1v1前端（点击手框交互，蛋糕弹窗，抢夺弹窗）
├── model/
│   ├── Player.hx          # 基类（所有虚方法钩子 + DamageResult + CustomAction typedef）
│   ├── Camp.hx            # HERO / REBEL / RENEGADE
│   ├── DamageType.hx      # PHYSICAL / MAGIC / TRUE
│   ├── HealType.hx        # RECOVERY / SUPPLY
│   ├── ShieldType.hx      # PHYSICAL / MAGIC / BOTH_PHYSICAL_MAGIC / TRUE
│   └── ShieldInstance.hx
├── buffs/
│   ├── Buff.hx            # 基类
│   ├── PoisonBuff.hx      # 毒（MAGIC伤害，走handleIncomingDamage，notifyPoisonTick）
│   ├── ReflectBuff.hx     # 反弹（用 GameEngine.isReflecting 实例守卫，非静态）
│   ├── FrozenBuff.hx      # 冰冻（跳过下个自己回合）
│   ├── DamageBoostBuff.hx # 双4伤害翻倍
│   ├── ExtraActionBuff.hx # 双8额外行动
│   └── InvincibleBuff.hx  # 无敌
├── character/
│   ├── CharacterRegistry.hx  # 角色注册中心（新增角色只改这里一行）
│   ├── XiaoQiao.hx           # 小乔 HP180
│   ├── ZangShi.hx            # 藏师 HP330
│   ├── FaShi.hx              # 法师 HP80
│   ├── SunWuKong.hx          # 孙悟空 HP130
│   ├── DaQiao.hx             # 大乔 HP60
│   ├── RenZhe.hx             # 忍者 HP150
│   └── ZhangFei.hx           # 张飞 HP280
└── ai/
    ├── AIThink.hx            # 启发式评估AI（可实例化，支持权重进化）
    ├── AIBattleRunner.hx     # AI自动对战循环（冠军vs挑战者）
    └── BattleLearning.hx     # 权重进化学习系统（EvolutionaryStrategy+Elo）
```

---

## 核心架构（策略模式+钩子）

### GameEngine 事件总线

```haxe
// 关键事件广播（所有角色通过钩子监听）
notifyHealEvent(healer, amount, type, isFromSkill)   // 回血
notifyShieldEvent(target, isFromSkill)                // 获盾
notifyOutputDamage(attacker, target, outputDamage, type) // 伤害输出
notifyPoisonTick(victim, actualDamage)               // 毒伤扣血
notifyPoisonCleared(victim)                          // 解毒一层
notifyThunderTick(caster, victim, actualDamage)      // 雷霆扣血

// 伤害/回血接口
applyDamage(actor, target, baseAmount, type)   // 标准（走calculate+事件+钩子）
applyRawDamage(actor, target, amount, type)    // 原始（防套娃，不广播）
applyHeal(actor, baseAmount, type)             // 标准（走calculate+事件+钩子）
applyRawHeal(actor, amount, type, isFromSkill) // 原始
applyShield(actor, type, amount, duration)     // 统一获盾（触发notifyShield）
```

### Player.hx 虚方法钩子（子类按需override）

```haxe
calculateOutputDamage(baseAmount, type):Int    // 出伤倍率（小乔×1.5，张飞模态）
calculateFinalHeal(baseAmount, type):Int        // 回血倍率
handleIncomingDamage(attacker, amount, type):DamageResult  // 受伤减免（藏师减半）
onAfterDealtDamage(target, dbs, actual, type, engine)  // 打完人后（忍者加毒，小乔补给）
onAfterHeal(actual, type, engine)               // 回血后（小乔打人）
onAnyHealHappened(healer, amount, type, isFromSkill, engine)  // 全场回血监听
onAnyShieldGained(target, isFromSkill, engine)  // 全场获盾监听
onAnyOutputDamage(attacker, target, output, type, engine)  // 全场输出监听（孙悟空x）
onAnyPoisonTick(victim, actual, engine)         // 全场毒伤监听（忍者回血）
onAnyPoisonCleared(victim, engine)              // 全场解毒监听（忍者回20）
onAnyThunderTick(caster, victim, actual, engine)  // 雷霆监听（法师回血）
onBigRoundEnd()                                 // 大回合结束（藏师蛋糕重置）
onAfterTouchResolved()                          // 碰手结算完（孙悟空0增益检查）
onEnterZeroComboContext()                       // 进入0组合（法师激活翻倍）
onExitZeroComboContext()                        // 退出0组合
tryOverrideComboEffect(comboKey, target, engine):Bool  // 覆盖默认组合（孙悟空[0,2]）
shouldSkipZeroTurnsDecrement():Bool             // 跳过0递减（孙悟空[0,2]延寿）
tryRevive(engine):Bool                          // HP归零时复活机会（大乔复活甲）
handleAction(actionName, params, engine):String // 前端动作派发（蛋糕/进化/抢夺）
getCustomDisplay():String                       // 角色卡片特殊显示（蛋糕数/xy值）
getCustomActions():Array<CustomAction>          // 角色卡片特殊按钮
getSnapshotExtras():Array<String>               // 日志快照附加信息
isValidTouch(handIdx, target, targetHandIdx):Bool  // 碰手合法性（孙悟空后果预判）
```

### 加新角色只需两步

1. 创建 `character/XxxYyy.hx`，重写需要的钩子
2. `CharacterRegistry.init()` 加一行 `register("id", "显示名 HP", hp, factory)`

---

## 已实现的8个英雄

| 英雄 | HP | 类型 | 核心特点 |
|------|-----|------|---------|
| 小乔 | 180 | 半肉 | 物伤/回血×1.5，互相联动，0留3回合，盾升级 |
| 藏师 | 330 | 坦克 | 物免50%+反弹50%，回复×2.5，蛋糕法伤（自身造伤/回复/获盾产蛋糕） |
| 法师 | 80 | 刺杀 | 0组合物伤翻倍+45法伤+雷霆之怒，雷霆击中自己回血 |
| 孙悟空 | 130 | 半肉 | x/y动态增益随全场伤害/回血更新，[0,2]冻结+70法伤，0延寿 |
| 大乔 | 60 | 天后 | 抢夺全场RECOVERY的50%，打人回血50%，进化神大乔，复活甲 |
| 忍者 | 150 | 半肉 | 物伤附加50%法伤+1毒，毒伤/解毒回血，敌方毒层提供减伤 |
| 张飞 | 280 | 坦克 | 三模态，差值免伤，怒气积累狂暴（0延寿+免伤翻倍+物伤×1.5叠加） |
| 杨大力 | 1000 | 沙包 | 无技能，测试用 |

---

## 关键规则（易忘）

**0机制：** 碰出0 → 启动倒计时(initTurns=2，小乔/孙悟空狂暴=3)，归零后强制只能动0手；双手全0时，该玩家下回合必须用0手行动（系统自动选择）；对方双手全0则跳过回合但状态照常结算。

**伤害计算顺序：**
```
calculateOutputDamage → notifyOutputDamage → onDealDamage Buff(双4)
→ handleIncomingDamage(角色减免 → Buff拦截 → 护盾) → onAfterDealtDamage
```

**回血类型：**
- RECOVERY：可解毒（每20血解1层），可被大乔抢，更新孙悟空y
- SUPPLY：纯加血，不解毒，大乔不抢，不更新孙悟空y

**护盾消耗顺序：** 剩余回合短的优先消耗。

**组合优先级：** 双子星 > [0,x] > 单手6

**大回合：** 所有玩家都行动一次=一大回合，turnCount在大回合末尾+1（不是每人行动+1）。

---

## 前端交互架构

**index.html**（1v1）：
- 点击己方手框 → 选定（高亮绿色）
- 点击敌方手框 → 触发攻击（调 `engine.handleTouch` + `turnManager.nextTurn`）
- 角色卡片动态按钮：由 `getCustomActions()` 生成，统一调 `Main.invokeAction(idx, name, params)`
- 大乔抢夺：动态插入目标卡片内（非fixed弹窗），5秒倒计时
- 藏师蛋糕：固定弹窗，选组数×选目标×确认

**Main.invokeAction(actorIdx, actionName, params)：**
统一前端动作入口，内部调 `actor.handleAction(...)` 分发给各角色。
*
---

## AI系统

**AIThink.hx**：启发式评估（可实例化）
- 每个实例有独立 `WeightSet`，支持 `mutateWeights` 变异
- 评估 = 即时收益 + 组合潜力 + 风险 + 角色特化（无副作用纯函数）
- 静态 `chooseAction` 向下兼容

**BattleLearning.hx**：权重进化（Evolutionary Strategy）
- 冠军 vs 挑战者（挑战者=冠军权重±12%变异）
- 每20场评估一次，赢率>58%升格为新冠军
- Elo评分系统，结构化事件记录（不靠解析日志文字）

**AIBattleRunner.hx**：自动对战循环
- P1用冠军权重，P2用挑战者权重
- 每N场提示用户是否继续，支持复盘分析

---

## 待做事项

1. **2v2 平台（index2.html）**：
   - 行动顺序 1234，1&3一队 2&4一队 
   - 双半肉流：每回合可切换"抗伤位"，只能打到抗伤位（孙悟空[0,2]无视）
   - 坦脆流：有距离限制，脆皮只打敌方坦克（孙悟空[0,2]无视），坦克打任意
   - 帮抗机制：替队友抗伤 × 1.5惩罚系数，帮抗时被帮者的护盾/免伤不触发
   - 双半肉加强：坦克位回血×1.5，盾延长1回合且升级为物法盾

2. **前端素材化**（计划中）：OpenFL框架，迁移到Canvas

---

## 给新窗口的提示

- 用户用**中文**交流
- 新增角色只改 `CharacterRegistry.hx` + 新建角色文件，不改 Main/Engine/TurnManager
- 前端动作一律通过 `Main.invokeAction` 派发，不单独写专用方法
- 对话时可要求用户上传最新版的关键 `.hx` 文件（上下文丢失时）
- 编译命令：`haxe build.hxml`（在项目根目录）



阴阳师  120血  半肉
1. 你有三种模态： 阴；阳；人； 每次到你动时，你可以通过点击按钮切换模态（和张飞模态切换一样）
2. 阴： 你所有的输出翻为3.5倍，比如[0,1]基础伤害40，你造成140物理伤害；你所有的回复也变成打3.5倍的伤害，比如[0,6]回复30，你变成造成105的物伤，但你受到的物法真伤害翻为1.5倍
3. 阳： 你所有的回复翻为3.5倍，比如[0,6]回复30，你回复105，你所有造成伤害的方式也变成回复，比如[0,1]基础伤害40，你回复140血，但你受到的物法真伤害翻为1.5倍
4. 人： 你的输出降低为0.5倍，获得1/4的物法免伤，所有的回复翻为1.5倍
5. 每次由人切换为阴/阳时，你获得敌人数*25的物法护盾，此护盾是你的特殊护盾，每次到下一次你动时-20. 比如本回合你由人切换为阴，敌人1个，获得25物法护盾。然后对方动完了，到你，你还没动，此时护盾-20，剩下5（相当于覆盖接下来敌人的行动轮，让护盾帮你抗伤）
6. 每次由阴阳切回人时，你回复护盾的血量
7. 阴阳直接切换时，护盾归零，你扣除当前护盾厚度一般的血量（物伤，可被[0,2]之类的护盾挡住）