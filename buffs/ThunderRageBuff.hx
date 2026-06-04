package buffs;

import model.Buff;
import model.Player;
import model.DamageType;

/**
 * 雷霆之怒 Buff（法师附加给敌人的）
 * - 持续3回合
 * - 持有者回合结束时，按双手中偶数(2,4,6,8)个数触发雷霆伤害
 * - 计数器以"隐藏Buff（id=THUNDER_COUNTER）"存在目标身上共享
 *   - 起步40，每触发一次 +15
 *   - 所有雷霆之怒Buff全部消失时重置为40
 * - 法师每次造成实际雷霆伤害 → 补给等量血给法师本人
 */
class ThunderRageBuff extends Buff {

    // 全局递增计数器，给每个雷霆Buff唯一ID（防止 Player.addBuff 合并）
    private static var _idCounter:Int = 0;

    // 触发雷霆伤害的施法者（法师）—— 用于回血归属
    public var caster:Player;

    // 引擎引用（在onTurnEnd里要用engine来走标准伤害流程）
    public var engine:GameEngine;

    public function new(caster:Player, engine:GameEngine, duration:Int = 3) {
        _idCounter++;
        // 用唯一ID避免被 addBuff 合并，但保留 THUNDER_RAGE 前缀方便识别
        super("THUNDER_RAGE_" + _idCounter, "雷霆之怒", duration);
        this.caster = caster;
        this.engine = engine;
    }

    override public function onTurnEnd(owner:Player) {
        if (this.layers <= 0) return;

        // 触发条件：本Buff实例当前回合到期则不再触发，仅减层
        // 但雷霆的设计是"持续3回合，每回合结束触发一次"
        // 所以先触发，再减层

        // 1. 统计双手偶数（2,4,6,8）个数（0不算偶数特殊处理）
        var evenCount = 0;
        for (h in owner.hands) {
            if (h == 2 || h == 4 || h == 6 || h == 8) evenCount++;
        }

        if (evenCount > 0 && caster != null && caster.hp > 0) {
            // 2. 读取计数器（隐藏Buff）
            var counterBuff = owner.getBuff("THUNDER_COUNTER");
            if (counterBuff == null) {
                counterBuff = new Buff("THUNDER_COUNTER", "雷霆计数器", 40);
                owner.addBuff(counterBuff);
            }

            // 3. 按偶数个数依次触发雷霆伤害
            //    每次伤害值 = 当前计数器值，伤害后计数器 +15
            for (i in 0...evenCount) {
                var damage = counterBuff.layers;
                trace('⚡ ${owner.name} 触发雷霆之怒！第 ${i + 1}/${evenCount} 次雷霆，伤害值 = ${damage}');

                // 用 applyRawDamage：雷霆伤害不享受法师(1)的物伤翻倍增益
                // 但仍走护盾、减伤、双4等其他Buff
                var result = engine.applyRawDamage(caster, owner, damage, PHYSICAL);

                // 4. 法师补给实际扣血量
                if (result.actualDamage > 0) {
                    engine.notifyThunderTick(caster, owner, result.actualDamage);
                }

                // 5. 计数器 +15（无论敌方实际扣血多少都+15）
                counterBuff.layers += 15;

                // 法师可能被反弹打死，但雷霆已经走完本次
                if (owner.hp <= 0) break;
            }
        }

        // 6. 本Buff消耗1层（持续回合-1）
        this.layers--;

        // 7. 如果owner没有任何"雷霆之怒"了（即将清理），重置计数器
        //    检测：当前实例 layers==0 且没有其他 THUNDER_RAGE_ 前缀的Buff
        if (this.layers <= 0) {
            var hasOtherRage = false;
            for (b in owner.buffList) {
                if (b == this) continue;
                if (b.layers <= 0) continue;
                if (b.id.indexOf("THUNDER_RAGE_") == 0) {
                    hasOtherRage = true;
                    break;
                }
            }
            if (!hasOtherRage) {
                var cb = owner.getBuff("THUNDER_COUNTER");
                if (cb != null) {
                    trace('🌀 ${owner.name} 所有雷霆之怒已结束，计数器重置（下次施加重新从40起）。');
                    cb.layers = 0; // 标记清除
                }
            }
        }
    }
}
