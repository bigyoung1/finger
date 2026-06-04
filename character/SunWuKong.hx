package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import buffs.FrozenBuff;

/**
 * 孙悟空 (半肉 | HP: 130)
 * (1) 初始增益 x=30, y=15
 * (2) 场上有人回复时更新y为回复值；造成物伤时更新x为物伤值（只算输出端加成，不算target减伤）
 * (3) 回复时额外回复y的血量；造成物伤时额外造成x的物伤（防套娃）
 * (4) [0,2] 改为：70法伤 + 回70血 + 冻结对方1回合
 *     —— 同一次0增益最多3次，不消耗0使用次数（下回合跳过zeroTurns递减）
 */
class SunWuKong extends Player {

    public var x:Int = 30; // 物伤增益
    public var y:Int = 15; // 回血增益

    // [0,2] 在当前0增益期间已使用次数（0增益重置时归零）
    public var zeroTwoUses:Int = 0;

    // [0,2] 触发后标记：下回合 TurnManager 跳过 zeroTurns 递减
    public var skipNextZeroDecrease:Bool = false;

    // 防套娃保护锁
    private var _inExtraEffect:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 130, camp);
        this.initTurns = 2;
    }

    // ─────────────────────────────────────────────────────────────
    // 【后果预判】重写触碰合法性校验
    // 0寿命耗尽时，如果本次碰撞能凑出 [0,2] 且次数未满，则放行
    // ─────────────────────────────────────────────────────────────
    override public function isValidTouch(handIdx:Int, target:Player, targetHandIdx:Int):Bool {
        var otherIdx = 1 - handIdx;

        if (this.hands[otherIdx] == 0) {
            var otherTurns = (otherIdx == 0) ? this.zeroTurns0 : this.zeroTurns1;
            if (otherTurns <= 0) {
                // 预测碰完后的双手状态
                var newValue = (this.hands[handIdx] + target.hands[targetHandIdx]) % 10;
                var nextHand0 = (handIdx == 0) ? newValue : this.hands[0];
                var nextHand1 = (handIdx == 1) ? newValue : this.hands[1];

                var isZeroTwo = (nextHand0 == 0 && nextHand1 == 2) || (nextHand0 == 2 && nextHand1 == 0);

                if (isZeroTwo && this.zeroTwoUses < 3) {
                    trace('🐒 [悟空后果预判] 0寿命已尽，但此操作能合出 [0,2]，大招会补偿寿命，放行！');
                    return true;
                }
                return false;
            }
        }

        return super.isValidTouch(handIdx, target, targetHandIdx);
    }

    // ─────────────────────────────────────────────────────────────
    // (2) 监听全场物伤输出事件，更新 x
    // ─────────────────────────────────────────────────────────────
    override public function onAnyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (attacker == null || type != PHYSICAL || outputDamage <= 0) return;
        if (_inExtraEffect) return; // 防止追加物伤的事件再次进来（也防止其他大乔抢导致的连锁）

        if (attacker == this) {
            var oldX = this.x;
            this.x = outputDamage + oldX; // 本次总输出 = 主+追加
            trace('🐒 [悟空被动] 自身造成物伤 ${outputDamage}，x：${oldX} → ${this.x}，追加 ${oldX} 点额外物伤！');

            _inExtraEffect = true;
            // 用 applyDamage 让追加伤害走标准流程（被双4加成等，但守卫防止再次进入本钩子）
            engine.applyDamage(this, target, oldX, PHYSICAL);
            _inExtraEffect = false;
        } else {
            var oldX = this.x;
            this.x = outputDamage;
            trace('🐒 [悟空被动] 全场物伤监听，x：${oldX} → ${this.x}');
        }
    }

    override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {
        if (amount <= 0) return;
        if (_inExtraEffect) return;

        if (healer == this) {
            // 仅更新 y（追加回血已在 calculateFinalHeal 里合并为一段，不在此处二次触发）
            var oldY = this.y;
            this.y = amount;
            trace('🐒 [悟空被动] 自身回血事件 ${amount}，y：${oldY} → ${this.y}');
        } else {
            var oldY = this.y;
            this.y = amount;
            trace('🐒 [悟空被动] 全场回血监听，y：${oldY} → ${this.y}');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // (3) 回血时额外回复y（合并为一段，不产生第二次广播）
    // ─────────────────────────────────────────────────────────────
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        if (_inExtraEffect) return baseAmount;
        var bonus = this.y;
        var total = baseAmount + bonus;
        if (bonus > 0) {
            trace('🐒 [悟空被动] 回血合并：${baseAmount} + y(${bonus}) = ${total}（单段广播）');
        }
        return total;
    }

    // ─────────────────────────────────────────────────────────────
    // (4) [0,2] 大招覆盖
    // ─────────────────────────────────────────────────────────────
    override public function tryOverrideComboEffect(comboKey:String, target:Player, engine:GameEngine):Bool {
        // 注意：GameEngine 生成的 comboKey 格式是 "0_2"（下划线）
        if (comboKey != "0_2") return false;

        if (zeroTwoUses >= 3) {
            trace('ℹ️ 孙悟空本次0增益已用满3次 [0,2]，本次走默认20护盾。');
            return false;
        }

        zeroTwoUses++;
        trace('🐒🔥 [悟空大招] 第 ${zeroTwoUses}/3 次 [0,2]！70法伤 + 回70血 + 冻结${target.name}！');

        // 1. 70 法伤（走 applyDamage，法伤不被 calculateOutputDamage 的物伤加成影响）
        engine.applyDamage(this, target, 70, MAGIC);

        // 2. 回 70 血（走 applyHeal，会被 onAnyHealHappened 触发 y 更新和追加回血）
        engine.applyHeal(this, 70, RECOVERY);

        // 3. 冻结对方 1 回合
        if (target.hp > 0) {
            target.addBuff(new FrozenBuff(1));
            trace('🥶 ${target.name} 被冻结 1 回合！');
        }

        // 4. 标记：下回合 TurnManager.onTurnStart 时跳过 zeroTurns 递减（不消耗0使用次数）
        //    用 skipNextZeroDecrease 而不是立刻 +1，避免时机错误多补一回合
        skipNextZeroDecrease = true;
        trace('🐒 [0,2] 标记延寿：下回合 zeroTurns 将跳过递减。');

        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // 跳过 zeroTurns 递减（供 TurnManager.onTurnStart 调用）
    // ─────────────────────────────────────────────────────────────
    override public function shouldSkipZeroTurnsDecrement():Bool {
        if (skipNextZeroDecrease) {
            skipNextZeroDecrease = false;
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────
    // 0增益结束时重置 [0,2] 计数器
    // ─────────────────────────────────────────────────────────────
    public function checkZeroComboReset():Void {
        if (hands[0] != 0 && hands[1] != 0) {
            if (zeroTwoUses > 0) {
                trace('🐒 0增益结束，[0,2]计数：${zeroTwoUses} → 0');
                zeroTwoUses = 0;
            }
        }
    }

    // GameEngine 每次碰手后调用此钩子，孙悟空借此检查0增益是否结束
    override public function onAfterTouchResolved():Void {
        checkZeroComboReset();
    }

    // ─────────────────────────────────────────────────────────────
    // 自描述接口
    // ─────────────────────────────────────────────────────────────
    override public function getCustomDisplay():String {
        return '🐒 x = <b>${x}</b> (物伤增益) | y = <b>${y}</b> (回血增益) | [0,2]: <b>${zeroTwoUses}/3</b>';
    }

    override public function getSnapshotExtras():Array<String> {
        return ['🐒x=${x},y=${y},[0,2]计数:${zeroTwoUses}/3'];
    }
}
