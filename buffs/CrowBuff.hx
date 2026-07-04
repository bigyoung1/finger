package buffs;

import model.Buff;
import model.Player;
import model.DamageType;
import model.HealType;

/**
 * 乌鸦buff（鸦眼技能1施加）
 * 持有者受到攻击时，攻击的「基础伤害」在乘算前加算：
 *   - 物理/真实：+20 × 触发次数
 *   - 法术/毒：  +10 × 触发次数
 * 触发次数 = 1 + extraTriggers（灼燃箭+2，魔王剑再+2）
 *
 * 每次触发后，通过 onTriggered 回调鸦眼：
 *   - 鸦眼RECOVERY回血 = 乘算后的额外增量（finalWithCrow - finalWithout）
 *   - 鸦眼获得乌鸦计数（触发次数个）
 *
 * 持续由鸦眼自己的行动节奏控制：每个 CrowBuff 各自记录剩余行动计数，释放后到下下次鸦眼行动开始时移除，不按大回合递减。
 */
class CrowBuff extends Buff {

    public var duration:Int;
    public var extraTriggers:Int = 0; // 灼燃箭注入

    private var _yaYan:Dynamic; // YaYan 引用（Dynamic避免循环依赖）

    public function new(duration:Int, yaYan:Dynamic) {
        super("CROW", "乌鸦诅咒(" + duration + "回合)", 1);
        this.duration = duration;
        _yaYan = yaYan;
    }

    /** 返回本次攻击基础伤害的加算量（在攻击者乘算之前加） */
    public function getBaseBonus(type:DamageType):Int {
        var triggers = 1 + extraTriggers;
        return switch(type) {
            case PHYSICAL: 20 * triggers;
            case MAGIC:    10 * triggers;
            case TRUE:     20 * triggers;
        };
    }

    public function isOwnedBy(p:Dynamic):Bool {
        return _yaYan == p;
    }

    /** GameEngine 在算出 finalAmount 后调用：回调鸦眼回血 + 获取乌鸦 */
    public function onTriggered(crowHeal:Int, engine:GameEngine):Void {
        var triggers = 1 + extraTriggers;
        if (_yaYan != null) {
            var yaYan = cast(_yaYan, character.YaYan);
            // 关键修复：鸦眼已经死了就不再回血/积累乌鸦，避免死人被乌鸦buff复活
            if (yaYan.hp <= 0) {
                trace('🦅 乌鸦触发：但鸦眼已阵亡，跳过回血与乌鸦积累');
                extraTriggers = 0;
                return;
            }
            trace('🦅 乌鸦触发：额外伤害 ${crowHeal}，鸦眼回 ${crowHeal} 血，获得 ${triggers} 只乌鸦');
            yaYan.crowCount += triggers;
            engine.applyRawHeal(yaYan, crowHeal, RECOVERY, true);
        }
        // 重置 extraTriggers（本次攻击消费完）
        extraTriggers = 0;
    }

    override public function onBigRoundEnd(owner:Player):Void {
        // 不再按大回合衰减；由 YaYan.shouldSkipZeroTurnsDecrement() 在鸦眼自己的行动开始时按 duration 移除。
    }
}
