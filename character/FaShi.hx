package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import buffs.ThunderRageBuff;

/**
 * 法师（攻击 | HP 80）
 * (1) 触发"0"组合时：物理伤害翻倍 + 附加最多 45 法术伤害 + 给敌方加 1 层【雷霆之怒】
 *     —— 物伤翻倍是法师的被动倍率（calculateOutputDamage 在 PHYSICAL+from0Combo时触发）
 *     —— 但 [0,x] 组合的物伤都是基础40，所以翻倍变 80；如有双4加成则继续叠加
 *     —— 附加法伤45在 onAfterDealtDamage 钩子里追加打一下（走标准流程）
 * (2) 雷霆之怒 Buff 详见 ThunderRageBuff.hx
 * (3) 雷霆伤害不享受(1)的物伤翻倍 → 在 ThunderRageBuff 内用 applyRawDamage 绕过 calculateOutputDamage
 *     法师补给雷霆造成的实际扣血量 → 在 ThunderRageBuff 内调 applyRawHeal
 */
class FaShi extends Player {

    // 标记：当前是否处于"0组合伤害"的施法上下文，用于让 calculateOutputDamage 知道要翻倍
    private var _inZeroCombo:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 160, camp);
    }

    // ── (1) 触发0组合时物伤翻倍 ──
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (_inZeroCombo && type == PHYSICAL) {
            var boosted = baseAmount * 2;
            trace('⚡ 法师 0组合触发物伤翻倍：${baseAmount} → ${boosted}');
            return boosted;
        }
        return baseAmount;
    }

    /**
     * 由 GameEngine 触发 0 组合时调用：法师标记进入"0组合上下文"
     * 这样接下来的 applyDamage 会让 calculateOutputDamage 翻倍
     * 调用结束后必须复位
     */
    override public function onEnterZeroComboContext():Void {
        _inZeroCombo = true;
    }
    override public function onExitZeroComboContext():Void {
        _inZeroCombo = false;
    }

    // ── (1) 物伤造成后追加 45 法伤 + 1 层雷霆 ──
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        // 只在"0组合上下文"内追加，避免雷霆本身的反伤再触发追加
        if (!_inZeroCombo) return;
        if (type != PHYSICAL) return;
        if (target.hp <= 0) return;

        // 1. 追加 45 法伤（走标准伤害流程，会被法盾/物法盾抵挡）
        trace('⚡ 法师【0组合·追加】对 ${target.name} 造成 45 点法术伤害！');
        _inZeroCombo = false;
        engine.applyDamage(this, target, 45, MAGIC);
        _inZeroCombo = true;

        // 2. 附加 1 层雷霆之怒
        if (target.hp > 0) {
            trace('⚡ 法师给 ${target.name} 附加 1 层【雷霆之怒】！');
            target.addBuff(new ThunderRageBuff(this, engine, 3));
        }
    }

    /**
     * 监听雷霆扣血：只有自己是caster时回血（解耦：ThunderRageBuff不再持有回血逻辑）
     */
    override public function onAnyThunderTick(caster:Player, victim:Player, actualDamage:Int, engine:GameEngine):Void {
        if (caster != this) return;
        if (actualDamage <= 0) return;
        trace('⚡ 法师雷霆回复 ${actualDamage} 血！');
        engine.applyRawHeal(this, actualDamage, SUPPLY, true);
    }
}
