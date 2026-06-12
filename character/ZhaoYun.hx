package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;

/**
 * 赵云（半肉 | HP: 200）
 *
 * 技能1 - 初始增益：x=20（物伤加成），y=10（回血加成）
 *
 * 技能2 - 攻防联动：
 *   造成物理伤害时：calculateOutputDamage 把 x 合并（让双4/鸦眼等乘数作用到 x 上）
 *     之后 onAnyOutputDamage 用「总输出 / 2」更新 y（含单手被动造成的伤害）
 *   回血时：calculateFinalHeal 把 y 合并（单段广播）
 *     之后 onAnyHealHappened 用「总回血量」更新 x（含单手被动回的血）
 *
 * 技能3 - 单手被动（新变出才触发，0组合期间不触发）：
 *   手变为 1 / 4 → 回复 10 血（走 applyHeal，calculateFinalHeal 自动 +y）
 *   手变为 5 / 8 / 9 → 造成 20 物理伤害（走 applyDamage，calculateOutputDamage 自动 +x）
 *   ⚠️ 0组合期间（如 [0,9] 碰出9）：不触发额外的20伤/10回血
 *      0组合本身已经走了 calculateOutputDamage（含+x），不重复触发
 *
 * 防套娃说明：
 *   - _inZeroCombo：0组合期间禁止单手被动触发
 *   - 单手被动的输出/回血会正常更新 y/x（y=输出/2 不会无限增长）
 */
class ZhaoYun extends Player {

    @:keep public var x:Int = 20; // 物伤加成
    @:keep public var y:Int = 10; // 回血加成

    // 0组合期间（onEnterZeroComboContext ~ onExitZeroComboContext）禁止单手被动
    private var _inZeroCombo:Bool = false;

    // 记录上次碰手结束后的双手值（单手被动"新变出"检测）
    private var _prevHand0:Int = 1;
    private var _prevHand1:Int = 1;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 200, camp);
    }

    // ─────────────────────────────────────────────────────────────
    // 技能2a：物理伤害合并 x（让双4/鸦眼buff等乘数作用到 x 上）
    // ─────────────────────────────────────────────────────────────
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (type != PHYSICAL) return baseAmount;
        var merged = baseAmount + this.x;
        trace('🐉 [赵云] 物伤合并：base(${baseAmount}) + x(${this.x}) = ${merged}');
        return merged;
    }

    // ─────────────────────────────────────────────────────────────
    // 技能2a 后续：监听自己的输出事件，用「总输出 / 2」更新 y
    // 主动攻击和单手被动都会更新（y=输出/2，不会无限增长）
    // ─────────────────────────────────────────────────────────────
    override public function onAnyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (attacker != this) return;
        if (type != PHYSICAL || outputDamage <= 0) return;
        var newY = Std.int(Math.max(10, outputDamage / 2));
        trace('🐉 [赵云] 本次物理总输出 ${outputDamage}，y：${this.y} → ${newY}（输出/2）');
        this.y = newY;
    }

    // ─────────────────────────────────────────────────────────────
    // 技能2b：回血合并 y（单段广播）
    // ─────────────────────────────────────────────────────────────
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        var base  = super.calculateFinalHeal(baseAmount, type); // 含坦克加成
        var total = base + this.y;
        trace('🐉 [赵云] 回血合并：${base} + y(${this.y}) = ${total}（单段广播）');
        return total;
    }

    // ─────────────────────────────────────────────────────────────
    // 技能2b 后续：监听自己的回血事件，用「总回血量」更新 x
    // 主动回血和单手被动都会更新
    // ─────────────────────────────────────────────────────────────
    override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {
        if (healer != this) return;
        if (amount <= 0) return;
        var newX = Std.int(Math.max(20, amount));
        trace('🐉 [赵云] 本次总回血 ${amount}，x：${this.x} → ${newX}（总回血量）');
        this.x = newX;
    }

    // ─────────────────────────────────────────────────────────────
    // 0组合上下文标记（[0,9]等0组合期间不触发单手被动）
    // ─────────────────────────────────────────────────────────────
    override public function onEnterZeroComboContext():Void {
        _inZeroCombo = true;
    }

    override public function onExitZeroComboContext():Void {
        _inZeroCombo = false;
    }

    // ─────────────────────────────────────────────────────────────
    // 技能3：单手被动（新变出才触发，0组合期间跳过）
    //   1/4 → 回复 10+y 血（calculateFinalHeal 自动合并 y）
    //   5/8/9 → 造成 20+x 物理伤害（calculateOutputDamage 自动合并 x）
    // ─────────────────────────────────────────────────────────────
    override public function onAfterTouchResolved():Void {
        var engine = GameEngine.instance;
        if (engine == null) return;

        // 检测"本次新变出"的手值
        var newVals:Array<Int> = [];
        if (hands[0] != _prevHand0) newVals.push(hands[0]);
        if (hands[1] != _prevHand1) newVals.push(hands[1]);

        // 更新记录
        _prevHand0 = hands[0];
        _prevHand1 = hands[1];

        // 0组合期间不触发单手被动（0组合本身已经+x，不重复）
        if (_inZeroCombo) {
            trace('🐉 赵云单手被动：0组合期间跳过（手值 ${newVals}）');
            return;
        }

        for (v in newVals) {
            if (v == 1 || v == 4) {
                trace('🐉 赵云单手 [${v}] 被动触发：回复 10+y=${10 + this.y} 血');
                engine.applyHeal(this, 10, RECOVERY);
            } else if (v == 5 || v == 8 || v == 9) {
                var target = engine.findEnemyTarget(this);
                if (target != null && target.hp > 0) {
                    trace('🐉 赵云单手 [${v}] 被动触发：造成 20+x=${20 + this.x} 物理伤害给 ${target.name}');
                    engine.applyDamage(this, target, 20, PHYSICAL);
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 自描述接口
    // ─────────────────────────────────────────────────────────────
    override public function getCustomDisplay():String {
        return '🐉 x = <b>${x}</b>（物伤加成）| y = <b>${y}</b>（回血加成）';
    }

    override public function getSnapshotExtras():Array<String> {
        return ['🐉x=${x}(物伤加成),y=${y}(回血加成)'];
    }

    @:keep override public function canReceiveHelpTank():Bool { return true; }
}
