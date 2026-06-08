package;

import model.Player;
import model.Player.DamageResult;
import model.DamageType;
import model.HealType;
import model.ShieldType;
import model.ShieldInstance;
import model.Buff;
import buffs.DamageBoostBuff;
import buffs.ReflectBuff;
import buffs.PoisonBuff;
import buffs.ExtraActionBuff;
import buffs.InvincibleBuff;

class GameEngine {

    public var turnManager:TurnManager;
    public static var instance:GameEngine;
    public var isReflecting:Bool = false; // 防止反弹伤害无限循环（替代ReflectBuff的静态变量）

    // ── 帮抗伤害记录 ──
    // handleTouch 期间自动记录对 dmgTarget 造成的每一笔伤害（type + 输出值）
    public var lastApplyDamageBase:Int = 0;
    public var currentComboMultiplier:Float = 1.0;
    public var _skipAttackerDealBuffs:Bool = false; // 组合特殊倍率（如双九1.5^N），在加算之后、calculateOutputDamage之前应用
    @:keep public var lastTouchDamageLog:Array<Dynamic> = []; // {type:DamageType, outputAmount:Int}
    public var lastTouchDamageTarget:Player = null;
    private var _recordingDamage:Bool = false;

    // ── 帮抗结算快照（攻击前的 victim 防御状态 + 本次记录的伤害）──
    private var _htVictim:Player = null;
    private var _htVictimHp:Int = 0;
    private var _htVictimShields:Array<ShieldInstance> = [];
    private var _htDamageSnapshot:Array<Dynamic> = [];

    public function new() {
        GameEngine.instance = this;
    }

    public function setTurnManager(tm:TurnManager) {
        this.turnManager = tm;
    }

    // ─────────────────────────────────────────────────────────────
    // 【全场事件通知系统】用于藏师草莓蛋糕等"全场监听"技能
    // ─────────────────────────────────────────────────────────────
    
    /**
     * 通知场上所有玩家：发生了一次回血事件
     * @param healer 回血目标
     * @param amount 实际回血量
     * @param type   回血类型
     * @param isFromSkill 是否来自技能内部调用（如毒伤反向、藏师补给）—— 这类事件不算蛋糕来源
     */
    public function notifyHealEvent(healer:Player, amount:Int, type:HealType, isFromSkill:Bool = false) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyHealHappened(healer, amount, type, isFromSkill, this);
        }
    }

    /**
     * 通知场上所有玩家：发生了一次获取护盾事件
     */
    public function notifyShieldEvent(target:Player, isFromSkill:Bool = false) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyShieldGained(target, isFromSkill, this);
        }
    }

    /**
     * 通知场上所有玩家：发生了一次"伤害输出"事件（攻击者侧加成完毕，未进 target 减伤）
     * 用于孙悟空根据全场最终输出值更新 x
     */
    public function notifyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyOutputDamage(attacker, target, outputDamage, type, this);
        }
    }

    /**
     * 通知场上：某玩家因毒伤扣了一次血（PoisonBuff 主动调）
     */
    public function notifyPoisonTick(victim:Player, actualPoisonDamage:Int) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyPoisonTick(victim, actualPoisonDamage, this);
        }
    }

    /**
     * 通知场上：某玩家解了一层毒（doHealing 解毒时调）
     */
    public function notifyPoisonCleared(victim:Player) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyPoisonCleared(victim, this);
        }
    }

    /**
     * 通知场上：某玩家因雷霆之怒扣了一次血
     */
    public function notifyThunderTick(caster:Player, victim:Player, actualDamage:Int) {
        if (turnManager == null) return;
        for (p in turnManager.players) {
            if (p.hp <= 0) continue;
            p.onAnyThunderTick(caster, victim, actualDamage, this);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 【标准】伤害与回血流程（带角色加成 + 触发钩子）
    // ─────────────────────────────────────────────────────────────

    /**
     * 标准伤害流程：actor用baseAmount攻击target
     * 1. actor.calculateOutputDamage 加成（如小乔1.5倍）
     * 2. target.handleIncomingDamage 走护盾+扣血，返回 {damageBeforeShield, actualDamage}
     * 3. 触发 actor.onAfterDealtDamage 钩子（如小乔补给）
     */
    /**
     * 标准伤害流程：actor用baseAmount攻击target
     * 1. actor.calculateOutputDamage 加成（如小乔1.5倍、孙悟空+x）
     * 2. 预算 attacker 的 onDealDamage Buff 加成（双4等）—— 用于通知最终输出值给孙悟空
     * 3. target.handleIncomingDamage 走护盾+扣血
     * 4. 触发 actor.onAfterDealtDamage 钩子
     */
    public function applyDamage(actor:Player, target:Player, baseAmount:Int, type:DamageType):DamageResult {
        // 暴露原始 baseAmount 给 onAfterDealtDamage 钩子用（如张飞模态2第二刀需要原始值重新走流程）
        this.lastApplyDamageBase = baseAmount;
        // 0. 目标身上的"基础加算buff"（如乌鸦诅咒+20），在攻击者乘算之前加
        //    返回修改后的 baseAmount，以及额外加了多少（供buff回调计算回血用）
        var crowExtra = 0;
        if (target != null) {
            for (b in target.buffList) {
                if (Std.isOfType(b, buffs.CrowBuff)) {
                    var cb = cast(b, buffs.CrowBuff);
                    crowExtra = cb.getBaseBonus(type);
                    break;
                }
            }
        }
        var adjustedBase = baseAmount + crowExtra;
        // 0c. 组合倍率（如双九的1.5^N），在加算之后、角色乘算之前应用
        if (currentComboMultiplier != 1.0) {
            adjustedBase = Std.int(adjustedBase * currentComboMultiplier);
            // baseAmount 也同步缩放，让 baseOnlyFinal 计算正确（无乌鸦版本也要×倍率）
            baseAmount = Std.int(baseAmount * currentComboMultiplier);
        }

        // 1. 角色加成（calculateOutputDamage）
        var baseOnlyFinal = (actor != null) ? actor.calculateOutputDamage(baseAmount, type) : baseAmount;
        var finalAmount   = (actor != null) ? actor.calculateOutputDamage(adjustedBase, type) : adjustedBase;

        // 1b. 攻击者增伤Buff（双4等）— 提前应用，使乌鸦回血差值和广播都包含双4效果
        //     用 snapshot/restore 避免重复消耗 layers；handleIncomingDamage 里用 _skipAttackerDealBuffs 标记跳过
        if (actor != null) {
            // 备份 layers
            var snapshot = [for (b in actor.buffList) b.layers];
            for (b in actor.buffList) {
                baseOnlyFinal = b.onDealDamage(actor, target, baseOnlyFinal, type);
            }
            // 还原 layers（不消耗）
            for (i in 0...actor.buffList.length) actor.buffList[i].layers = snapshot[i];
            // 真正消耗一次，应用到 finalAmount
            for (b in actor.buffList) {
                finalAmount = b.onDealDamage(actor, target, finalAmount, type);
            }
            // 标记 handleIncomingDamage 跳过 step 0（避免再次消耗）
            _skipAttackerDealBuffs = true;
        }

        // 2. 通知场上：本次"输出"的最终值（已含攻击者所有buff加成）
        notifyOutputDamage(actor, target, finalAmount, type);

        // 2b. 乌鸦buff回调：鸦眼回复乘算后的额外量
        if (crowExtra > 0 && target != null) {
            var crowHeal = finalAmount - baseOnlyFinal; // 乌鸦贡献的乘算后增量
            if (crowHeal > 0) {
                for (b in target.buffList) {
                    if (Std.isOfType(b, buffs.CrowBuff)) {
                        cast(b, buffs.CrowBuff).onTriggered(crowHeal, this);
                        break;
                    }
                }
            }
        }

        // ── 帮抗记录：记录对 lastTouchDamageTarget 造成的每笔输出伤害 ──
        if (_recordingDamage && target == lastTouchDamageTarget) {
            var tName = switch(type) {
                case PHYSICAL: "物理";
                case MAGIC:    "法术";
                case TRUE:     "真实";
            };
            lastTouchDamageLog.push({ type: type, outputAmount: finalAmount, typeName: tName });
        }

        // 3. 走标准抗伤
        var result = target.handleIncomingDamage(actor, finalAmount, type);

        // reset 标记（必须在 handleIncomingDamage 之后）
        _skipAttackerDealBuffs = false;

        // 4. 触发攻击者钩子
        if (actor != null) {
            actor.onAfterDealtDamage(target, result.damageBeforeShield, result.actualDamage, type, this);
        }

        return result;
    }

    /**
     * 原始伤害流程：不走 calculateOutputDamage，不触发钩子，不广播事件
     * 用途：钩子内部调用，防止套娃
     */
    public function applyRawDamage(actor:Player, target:Player, amount:Int, type:DamageType):DamageResult {
        // 乌鸦buff加算：先算无乌鸦的actor输出，再算有乌鸦的，差值即为乌鸦贡献
        var crowExtra = 0;
        if (target != null) {
            for (b in target.buffList) {
                if (Std.isOfType(b, buffs.CrowBuff)) {
                    crowExtra = cast(b, buffs.CrowBuff).getBaseBonus(type);
                    break;
                }
            }
        }
        // applyRawDamage 不走 calculateOutputDamage，但乌鸦的加算仍要体现乘算效果
        // 用 actor.calculateOutputDamage 推算差值（与 applyDamage 逻辑对齐）
        var baseOnlyFinal = (actor != null) ? actor.calculateOutputDamage(amount, type) : amount;
        var finalAmount   = (actor != null) ? actor.calculateOutputDamage(amount + crowExtra, type) : (amount + crowExtra);
        var crowHeal = finalAmount - baseOnlyFinal;

        // 帮抗记录（与 applyDamage 对齐）：记录对 lastTouchDamageTarget 造成的输出伤害
        if (_recordingDamage && target == lastTouchDamageTarget) {
            var tName = switch(type) {
                case PHYSICAL: "物理";
                case MAGIC:    "法术";
                case TRUE:     "真实";
            };
            lastTouchDamageLog.push({ type: type, outputAmount: finalAmount, typeName: tName });
        }

        var result = target.handleIncomingDamage(actor, finalAmount, type);
        if (crowHeal > 0 && target != null) {
            for (b in target.buffList) {
                if (Std.isOfType(b, buffs.CrowBuff)) {
                    cast(b, buffs.CrowBuff).onTriggered(crowHeal, this);
                    break;
                }
            }
        }
        return result;
    }

    /**
     * 标准回血流程
     */
    public function applyHeal(actor:Player, baseAmount:Int, type:HealType):Int {
        var finalAmount = actor.calculateFinalHeal(baseAmount, type);
        var actualHeal = doHealing(actor, finalAmount, type);
        actor.onAfterHeal(actualHeal, type, this);
        if (actualHeal > 0) {
            notifyHealEvent(actor, actualHeal, type, false);
            var idx = turnManager != null ? turnManager.players.indexOf(actor) : -1;
            if (idx >= 0) js.Syntax.code("if(window.VFX&&VFX.notifyHeal)VFX.notifyHeal({0},{1})", idx, type == SUPPLY ? "SUPPLY" : "RECOVERY");
        }
        return actualHeal;
    }

    /**
     * 原始回血流程：不触发倍率和钩子，但仍发出"回血事件"
     * 通过 isFromSkill 参数让监听器自行判断是否要计数
     */
    public function applyRawHeal(actor:Player, amount:Int, type:HealType, isFromSkill:Bool = true):Int {
        var actualHeal = doHealing(actor, amount, type);
        if (actualHeal > 0) {
            notifyHealEvent(actor, actualHeal, type, isFromSkill);
            // 通知 VFX：回血类型（SUPPLY=补给黄色，RECOVERY=绿色）
            var idx = turnManager != null ? turnManager.players.indexOf(actor) : -1;
            if (idx >= 0) js.Syntax.code("if(window.VFX&&VFX.notifyHeal)VFX.notifyHeal({0},{1})", idx, type == SUPPLY ? "SUPPLY" : "RECOVERY");
        }
        return actualHeal;
    }

    /**
     * 统一的"获取护盾"接口（标准路径，会触发全场护盾事件）
     * 子类（如藏师）可重写 addShield 来改变厚度/持续时间
     * @param isFromSkill 是否来自技能内部
     */
    public function applyShield(actor:Player, type:ShieldType, amount:Int, duration:Int, isFromSkill:Bool = false) {
        var finalType     = type;
        var finalAmount   = amount;
        var finalDuration = duration;

        // ── 坦脆流坦克护盾加成（叠在 actor.addShield/角色override 之前） ──
        if (actor.tankFormationBonus) {
            if (finalType == BOTH_PHYSICAL_MAGIC) {
                // 已是物法盾 → 厚度×1.5
                finalAmount = Math.ceil(finalAmount * 1.5);
            } else {
                // 物理/法术盾 → 升级为物法盾，持续+1
                finalType     = BOTH_PHYSICAL_MAGIC;
                finalDuration = finalDuration + 1;
            }
        }

        actor.addShield(finalType, finalAmount, finalDuration);
        notifyShieldEvent(actor, isFromSkill);
    }

    /**
     * 游戏开始时调用：给坦脆流的坦克施加永久坦克加成 buff
     * JS 层在 startGame2 后调用
     */
    @:keep public function applyTankFormationBuff(playerIdx:Int):Void {
        if (turnManager == null) return;
        if (playerIdx < 0 || playerIdx >= turnManager.players.length) return;
        var p = turnManager.players[playerIdx];
        if (p == null) return;
        p.tankFormationBonus = true;
        trace('🏰 [坦脆流] ${p.name} 获得坦克加强：回复×1.5，护盾升级为物法盾/厚度+50%');
    }

    /**
     * 内部：执行回血落地（含解毒逻辑），返回最终实际回血数值
     */
    private function doHealing(actor:Player, amount:Int, type:HealType):Int {
        var totalHealing = amount;
        var overflow = 0;

        // 只有 RECOVERY 类型才读取/写入 pendingHealing（溢出累计是解毒专用机制）
        if (type == RECOVERY) {
            overflow = actor.pendingHealing;
            actor.pendingHealing = 0;
            totalHealing = amount + overflow;

            if (overflow > 0) {
                trace('💚 ${actor.name} 获得 ${totalHealing} 点回血（${type}，本次 ${amount} + 溢出 ${overflow}）。');
            } else {
                trace('💚 ${actor.name} 获得 ${totalHealing} 点回血（${type}）。');
            }

            var poisonBuff = actor.getBuff("POISON");
            var poisonLayers = (poisonBuff != null) ? poisonBuff.layers : 0;

            if (poisonLayers > 0) {
                while (totalHealing >= 20 && poisonLayers > 0) {
                    totalHealing -= 20;
                    poisonLayers--;
                    // 通知场上：发生了一次"解毒一层"事件
                    notifyPoisonCleared(actor);
                }
                poisonBuff.layers = poisonLayers;

                if (poisonLayers == 0) {
                    trace('💊 完全解毒！${actor.name} 余 ${totalHealing} 血落地。');
                } else {
                    actor.pendingHealing = totalHealing;
                    trace('⚠️ 回血不足！剩 ${poisonLayers} 层毒，${totalHealing} 血储存到下次。');
                    totalHealing = 0;
                }
            }
        } else {
            // SUPPLY 直接落地，不解毒、不读溢出
            trace('💚 ${actor.name} 获得 ${amount} 点补给（SUPPLY，纯加血不解毒）。');
        }

        if (totalHealing > 0) {
            actor.hp += totalHealing;
        }
        return totalHealing;
    }

    // ─────────────────────────────────────────────────────────────
    // 核心触碰方法
    // ─────────────────────────────────────────────────────────────
    // 在 GameEngine.hx 中修改核心触碰方法
    /**
     * @param damageTarget 伤害承受者（2v2抗伤位传此参数；1v1传null则默认等于target）
     */
    public function handleTouch(actor:Player, handIdx:Int, target:Player, targetHandIdx:Int, ?damageTarget:Player):String {
        // 1. 基础死亡与0手碰撞校验
        if (target.hp <= 0) return "错误：目标已阵亡";
        if (target.hands[targetHandIdx] == 0) return "错误：不能碰撞数字 0";

        // 🌟 核心改动：把决定权交给角色自身（纯粹的面向对象规则预检）
        if (!actor.isValidTouch(handIdx, target, targetHandIdx)) {
            return "错误：当前 0 手寿命已耗尽，无法动用另一只手进行该交互！";
        }

        // 伤害承受者：未指定时默认与碰手目标相同（兼容1v1）
        var dmgTarget = (damageTarget != null) ? damageTarget : target;

        // ── 启动帮抗伤害记录 ──
        lastTouchDamageLog = [];
        lastTouchDamageTarget = dmgTarget;
        _recordingDamage = true;

        var oldValue    = actor.hands[handIdx];
        var targetValue = target.hands[targetHandIdx];

        // 2. 核心数学公式：指尖相加取模 10
        var newValue = (oldValue + targetValue) % 10;
        actor.hands[handIdx] = newValue;

        var touchDesc = (dmgTarget != target)
            ? '⚔️ [动作] ${actor.name} 用 [${oldValue}] 碰了 ${target.name} 的 [${targetValue}] -> 变为了 [${newValue}]（伤害由 ${dmgTarget.name} 承受）'
            : '⚔️ [动作] ${actor.name} 用 [${oldValue}] 碰了 ${target.name} 的 [${targetValue}] -> 变为了 [${newValue}]';
        trace(touchDesc);

        // 3. 产生 0 时启动寿命倒计时；否则清除该手的倒计时
        if (newValue == 0) {
            if (handIdx == 0) actor.zeroTurns0 = actor.initTurns;
            else              actor.zeroTurns1 = actor.initTurns;
            trace('🔢 ${actor.name} 第 ${handIdx} 手变为 0，启动 ${actor.initTurns} 回合倒计时。');
        } else {
            if (handIdx == 0) actor.zeroTurns0 = 0;
            else              actor.zeroTurns1 = 0;
        }

        // 4. 触发基础组合特效（伤害打给 dmgTarget）
        processBasicEffect(actor, target, dmgTarget, handIdx, oldValue, newValue);

        // 5. 碰手结算完毕钩子
        actor.onAfterTouchResolved();

        // ── 关闭帮抗记录 ──
        _recordingDamage = false;

        return "触碰结算成功";
    }

    private function processBasicEffect(actor:Player, target:Player, dmgTarget:Player, handIdx:Int, oldValue:Int, newValue:Int) {
        if (actor.hands[0] == actor.hands[1]) {
            triggerDoubleStar(actor, target, dmgTarget, actor.hands[0]);
            return;
        }
        if (actor.hands[0] == 0 || actor.hands[1] == 0) {
            var otherIdx   = (actor.hands[0] == 0) ? 1 : 0;
            var otherValue = actor.hands[otherIdx];
            triggerZeroCombo(actor, target, dmgTarget, otherValue);
            return;
        }
        if (actor.hands[0] == 6 || actor.hands[1] == 6) {
            if (newValue == 6 && oldValue != 6) {
                applyHeal(actor, 30, RECOVERY);
                trace('✨ ${actor.name} 触发 [x,6] 医术组合！');
            } else {
                trace('ℹ️ ${actor.name} 的 6 是老数字，不再触发回血。');
            }
            return;
        }
    }

    private function triggerDoubleStar(actor:Player, target:Player, dmgTarget:Player, num:Int) {
        switch (num) {
            case 9:
                var count = countMultiplesOf3OnField();
                var mult = Math.pow(1.5, count);
                trace('💥 ${actor.name} 凑齐【双九】！场上有 ${count} 个3的倍数(不含0)，基础60×1.5^${count}=${Std.int(60*mult)}（乌鸦+20会先加再乘）');
                currentComboMultiplier = mult;
                applyDamage(actor, dmgTarget, 60, PHYSICAL);
                currentComboMultiplier = 1.0;
                
             
            case 8:
                trace('🎉 ${actor.name} 凑齐【双八】！获得 2 次再动！');
                actor.addBuff(new ExtraActionBuff(2));

            case 7:
                trace('🎉 ${actor.name} 凑齐【双七】！30 点物伤 + 3 层中毒！');
                applyDamage(actor, dmgTarget, 30, PHYSICAL);
                dmgTarget.addBuff(new PoisonBuff(3));

            case 6:
                trace('✨ ${actor.name} 凑齐【双六】！恢复 90 血！');
                applyHeal(actor, 90, RECOVERY);

            case 5:
                trace('🎉 ${actor.name} 凑齐【双五】！获得 2 层反弹盾！');
                actor.addBuff(new ReflectBuff(2));

            case 4:
                trace('🎉 ${actor.name} 凑齐【双四】！获得 2 次伤害翻倍！');
                actor.addBuff(new DamageBoostBuff(2));

            case 2:
                trace('🎉 ${actor.name} 凑齐【双二】！30 点物法盾，3 回合！');
                applyShield(actor, PHYSICAL, 30, 3);

            case 3:
                trace('🎉 ${actor.name} 凑齐【双三】！30 点物法盾，3 回合！');
                applyShield(actor, PHYSICAL, 30, 3);

            case 1:
                trace('🎉 ${actor.name} 凑齐【双一】！获得无敌 2 回合！');
                actor.addBuff(new InvincibleBuff(2));

            case 0:
                trace('💀 ${actor.name} 凑齐【双零】！对目标造成 150 点真伤！');
                applyDamage(actor, dmgTarget, 150, TRUE);

            case _:
                trace('ℹ️ ${actor.name} 凑齐了双 [${num}]，暂无特效。');
        }
    }

    private function triggerZeroCombo(actor:Player, target:Player, dmgTarget:Player, otherValue:Int) {
        // 进入0组合上下文（法师重写此钩子激活物伤翻倍，其他角色默认空操作）
        actor.onEnterZeroComboContext();

        // 尝试角色技能覆盖（孙悟空[0,2]等，传 dmgTarget 让技能打正确的人）
        var comboKey = "0_" + otherValue;
        if (actor.tryOverrideComboEffect(comboKey, dmgTarget, this)) {
            actor.onExitZeroComboContext();
            actor.onAfterTouchResolved();
            return;
        }

        switch (otherValue) {
            case 6:
                trace('✨ ${actor.name} 触发 [0,6] 医术组合！');
                applyHeal(actor, 30, RECOVERY);
            case 4:
                trace('✨ ${actor.name} 触发 [0,4] 医术组合！');
                applyHeal(actor, 30, RECOVERY);
            case 7:
                trace('✨ ${actor.name} 触发 [0,7] 刺客组合：10 物伤 + 1 层中毒！');
                applyDamage(actor, dmgTarget, 10, PHYSICAL);
                dmgTarget.addBuff(new PoisonBuff(1));
            case 1 | 5 | 8 | 9:
                trace('✨ ${actor.name} 触发 [0,${otherValue}] 破军组合：40 点物伤！');
                applyDamage(actor, dmgTarget, 40, PHYSICAL);
            case 2 | 3:
                trace('✨ ${actor.name} 触发 [0,${otherValue}] 御守组合：20 点物法盾，3 回合！');
                applyShield(actor, PHYSICAL, 20, 3);
            case 0:
                trace('💀 ${actor.name} 触发 [0,0] 绝境！150 点真伤！');
                applyDamage(actor, dmgTarget, 150, TRUE);
            case _:
                trace('ℹ️ ${actor.name} 触发 [0,${otherValue}]，暂无特效。');
        }

        actor.onExitZeroComboContext();
    }


    private function countMultiplesOf3OnField():Int {
        var count = 0;
        if (turnManager != null && turnManager.players != null) {
            for (p in turnManager.players) {
                if (p.hp <= 0) continue;
                for (h in p.hands) {
                    if (h != 0 && h % 3 == 0) count++;
                }
            }
        }
        return count;
    }

    /**
     * 给子类（如小乔的onAfterHeal）用：找到敌方阵营的一个目标
     * 后期可扩展为支持选择目标
     */

    /**
     * 帮抗-步骤1：攻击前调用，快照 victim 的防御状态（hp + 护盾）
     * 供帮抗确认时恢复 victim（按规则被帮者完全不吃这次伤害）
     */
    @:keep public function snapshotHelpTankVictim(victim:Player):Void {
        _htVictim = victim;
        _htVictimHp = (victim != null) ? victim.hp : 0;
        _htVictimShields = [];
        if (victim != null) {
            for (s in victim.shieldList) {
                _htVictimShields.push(new ShieldInstance(s.type, s.amount, s.duration));
            }
        }
    }

    /**
     * 帮抗-步骤2：攻击后（确认 victim 濒死、有可帮抗队友时）调用，
     * 把本次 handleTouch 记录的伤害冻结成快照，免受后续 handleTouch 清空影响
     */
    @:keep public function captureHelpTankDamage():Void {
        _htDamageSnapshot = [];
        if (lastTouchDamageLog != null) {
            for (rec in lastTouchDamageLog) {
                _htDamageSnapshot.push({ type: rec.type, outputAmount: rec.outputAmount });
            }
        }
        trace('🛡️ [帮抗快照] 共记录 ${_htDamageSnapshot.length} 笔伤害');
    }

    /**
     * 帮抗-步骤3：玩家确认帮抗后调用
     * 1) 恢复 victim 到攻击前的 hp + 护盾（victim 完全不吃这次伤害）
     * 2) 把快照里的每笔输出伤害 ×1.5 打给 helper（只走 helper 自己的减伤/护盾）
     * 全部在 Haxe 内完成，不依赖 JS 侧的可变状态
     */
    @:keep public function resolveHelpTank(helperIdx:Int):Void {
        if (turnManager == null) return;

        // 1. 恢复 victim 防御快照
        if (_htVictim != null) {
            _htVictim.hp = _htVictimHp;
            _htVictim.shieldList = [];
            for (s in _htVictimShields) {
                _htVictim.shieldList.push(new ShieldInstance(s.type, s.amount, s.duration));
            }
            trace('🛡️ [帮抗] ${_htVictim.name} 被队友接管伤害，恢复到攻击前状态（HP ${_htVictimHp}）');
        }

        // 2. helper 承受 ×1.5 伤害
        if (helperIdx >= 0 && helperIdx < turnManager.players.length) {
            var helper = turnManager.players[helperIdx];
            if (helper != null && helper.hp > 0 && _htDamageSnapshot.length > 0) {
                trace('🛡️ [帮抗开始] ${helper.name} 替队友承受以下伤害 ×1.5：');
                for (rec in _htDamageSnapshot) {
                    var penaltyAmt = Math.ceil(rec.outputAmount * 1.5);
                    var dt:DamageType = rec.type; // 显式标注，避免与 ShieldType 同名值歧义
                    var typeStr = switch(dt) {
                        case PHYSICAL: "物理";
                        case MAGIC:    "法术";
                        case TRUE:     "真实";
                    };
                    trace('   → ${typeStr} ${rec.outputAmount} × 1.5 = ${penaltyAmt}');
                    // 走 handleIncomingDamage（attacker=null：不触发攻击者副作用，但走 helper 全部防御）
                    helper.handleIncomingDamage(null, penaltyAmt, dt);
                }
                trace('🛡️ [帮抗结算] ${helper.name} 剩余HP：${helper.hp}');
            }
        }

        // 清理快照
        _htVictim = null;
        _htVictimShields = [];
        _htDamageSnapshot = [];
    }

    /**
     * JS层可注入抗伤位解析器：2v2时由 game2-state.js 设置
     * 签名：function(actorIdx, defaultTargetIdx) -> Int (实际受伤目标idx)
     */
    public static var tankResolver:Dynamic = null;

    public function findEnemyTarget(actor:Player):Player {
        if (turnManager == null) return null;
        // 先找默认目标（第一个存活敌人）
        var defaultTarget:Player = null;
        var defaultIdx:Int = -1;
        for (i in 0...turnManager.players.length) {
            var p = turnManager.players[i];
            if (p == actor) continue;
            if (p.hp <= 0) continue;
            if (p.camp == actor.camp) continue;
            defaultTarget = p;
            defaultIdx = i;
            break;
        }
        if (defaultTarget == null) return null;

        // 2v2 抗伤位重定向：如果JS层注入了 tankResolver，走它
        if (tankResolver != null) {
            var actorIdx = -1;
            for (i in 0...turnManager.players.length) {
                if (turnManager.players[i] == actor) { actorIdx = i; break; }
            }
            var resolvedIdx:Int = tankResolver(actorIdx, defaultIdx);
            if (resolvedIdx >= 0 && resolvedIdx < turnManager.players.length) {
                var resolved = turnManager.players[resolvedIdx];
                if (resolved.hp > 0) return resolved;
            }
        }

        return defaultTarget;
    }
}
