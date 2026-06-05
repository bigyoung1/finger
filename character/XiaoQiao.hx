package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import model.ShieldType;

/**
 * 小乔（半肉 | HP 180）
 * (1) 所有回血量 × 1.5，造成物理伤害 × 1.5
 * (2) 回血时对敌方造成等量物理伤害；造成物伤时给自己补给等量生命
 *     ——两者不会循环套娃（用 applyRaw* 方法绕开钩子链）
 * (3) 0 可停留 3 回合（initTurns = 3）
 * (4) 获得的物理护盾升级为"物法护盾"，厚度 ×1.5，持续 +1 回合
 */
class XiaoQiao extends Player {

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 360, camp);
        this.initTurns = 3; // (3) 0可停留3回合
    }

    // ── (1) 出伤倍率 ──
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (type == PHYSICAL) {
            var boosted = Std.int(baseAmount * 1.5);
            trace('🌸 小乔物伤加成：${baseAmount} → ${boosted}');
            return boosted;
        }
        return baseAmount;
    }

    // ── (1) 回血倍率 ──
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        var base    = super.calculateFinalHeal(baseAmount, type); // 含坦克加成（×1.5 if tankFormationBonus）
        var boosted = Math.ceil(base * 1.5);
        trace('🌸 小乔回血加成：${base} → ${boosted}');
        return boosted;
    }

    // ── (2-a) 造成物伤后，给自己补给等量血量 ──
    // 规则统一：用实际扣血量（actualDamage）作为补给量
    // 例：打60→物免变30→护盾挡10→实际扣20，小乔补给20
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (type == PHYSICAL && actualDamage > 0) {
            trace('🌸 小乔触发"打人补给"：实际造成 ${actualDamage} 物伤 → 补给 ${actualDamage} 血！');
            // 用 applyRawHeal 绕过倍率和钩子，防止套娃
            engine.applyRawHeal(this, actualDamage, SUPPLY);
        }
    }

    // ── (2-b) 回血时对敌方造成等量物理伤害 ──
    override public function onAfterHeal(actualHeal:Int, type:HealType, engine:GameEngine):Void {
        if (actualHeal <= 0) return;
        var enemy = engine.findEnemyTarget(this);
        if (enemy == null) return;
        trace('🌸 小乔触发"回血反伤"：对 ${enemy.name} 造成 ${actualHeal} 点物伤！');
        // 用 applyRawDamage 绕过倍率和钩子，防止套娃
        engine.notifyOutputDamage(this, enemy, actualHeal, PHYSICAL);
        engine.applyRawDamage(this, enemy, actualHeal, PHYSICAL);
    }

    // ── (4) 所有护盾升级为物法盾，厚度×1.5，持续+1 ──
    override public function addShield(type:ShieldType, amount:Int, duration:Int) {
        var upgradedAmount = Std.int(amount * 1.5);
        var upgradedDuration = duration + 1;
        trace('🌸 小乔护盾升级：${amount}/${duration}回合 → ${upgradedAmount}/${upgradedDuration}回合 物法盾');
        super.addShield(BOTH_PHYSICAL_MAGIC, upgradedAmount, upgradedDuration);
    }

    // ── 单手2或3，新变出时触发护盾（和[x,6]回血逻辑一样）──
    // 效果与 [0,2]/[0,3] 组合相同（20点物理盾3回合，经小乔addShield升级后变物法盾×1.5）
    private var _prevHand0:Int = 1;
    private var _prevHand1:Int = 1;

    override public function onAfterTouchResolved():Void {
        var newTwo   = (hands[0] == 2 && _prevHand0 != 2)
                    || (hands[1] == 2 && _prevHand1 != 2);
        var newThree = (hands[0] == 3 && _prevHand0 != 3)
                    || (hands[1] == 3 && _prevHand1 != 3);

        _prevHand0 = hands[0];
        _prevHand1 = hands[1];

        if (newTwo || newThree) {
            var num = newTwo ? 2 : 3;
            trace('🌸 小乔触发 [x,${num}] 护盾被动：获得 20 点护盾（3回合）！');
            var engine = GameEngine.instance;
            if (engine != null) {
                engine.applyShield(this, PHYSICAL, 20, 3);
            }
        }
    }
}
