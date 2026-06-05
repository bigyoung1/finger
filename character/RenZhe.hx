package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import buffs.PoisonBuff;

/**
 * 忍者 (半肉 | HP: 150)
 *
 * (1) 造成物理伤害时，额外附加 50% 法伤（基于"双4等buff加成后"的物伤值，
 *     不算 target 的减伤/护盾），并回复"法伤实际造成的伤害"等量血量，
 *     同时给目标加 1 层毒
 *
 * (2) 场上任意"非忍者"单位（含队友）因毒伤扣血时，忍者补给"实际扣血量"等量血。
 *     场上"非忍者"单位每次解一层毒（忍者自己解毒不算），忍者回 20 血
 *
 * (3) 场上"非忍者"单位累计的毒层数 N，提供物法减伤：
 *     前3层每层15%（最高45%），超过45%后每层+10%（最高75%）
 *     忍者自己的毒不算
 *
 * 实现要点：
 *   - (1) 用 onAfterDealtDamage 钩子：物伤完成后用 _inExtraEffect 守卫追加法伤
 *   - (2) 用全局事件：场上 poison damage 时通知；场上解毒事件通知
 *         → 新增 GameEngine.notifyPoisonTick / notifyPoisonCleared 全局事件
 *   - (3) 重写 handleIncomingDamage，物法伤入口前先减伤
 */
class RenZhe extends Player {

    // 防止 (1) 追加法伤触发的钩子又触发 (1) 再追加
    private var _inExtraMagic:Bool = false;

    // 记录上一次"自己作为attacker的输出物伤值"（含双4加成，不含target减伤），给(1)用
    private var _lastOutputPhys:Int = 0;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 300, camp);
    }

    // 捕获自己输出物伤的最终值（含双4等加成，未进target减伤）
    override public function onAnyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (attacker == this && type == PHYSICAL) {
            _lastOutputPhys = outputDamage;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // (1) 造成物理伤害时，追加 50% 法伤 + 回血 + 加1层毒
    // ─────────────────────────────────────────────────────────────
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (type != PHYSICAL) return;
        if (_inExtraMagic) return; // 防套娃
        if (target.hp <= 0) return;

        // 法伤基数 = damageBeforeShield（含双4等buff加成后的物伤值，不含target减伤）
        // 用 applyRawDamage 让法伤走 target 的护盾/减伤，但不再触发攻击者的 calculateOutputDamage 和 DamageBoostBuff
        var magicDmg = Std.int(damageBeforeShield * 0.5);
        _lastOutputPhys = 0;

        if (magicDmg <= 0) {
            trace('🥷 忍者：物伤过小，本次追加法伤为0');
        } else {
            trace('🥷 忍者追加 ${magicDmg} 点法伤（基于含buff后物伤 ${damageBeforeShield} 的50%）！');
            _inExtraMagic = true;
            var result = engine.applyRawDamage(this, target, magicDmg, MAGIC);
            _inExtraMagic = false;
            if (result.actualDamage > 0) {
                trace('🥷 忍者回复 ${result.actualDamage} 血（法伤实际造成的）');
                engine.applyRawHeal(this, result.actualDamage, SUPPLY, true);
            }
        }

        // 加 1 层毒
        // 规则：
        //   普通攻击（无新7）→ 本钩子加1层
        //   新变出7（[1,7]/[0,7]/[7,7]）→ 本钩子跳过，由 onAfterTouchResolved 的 [x,7] 被动统一加1层
        //     [0,7] 组合本身已在 GameEngine 加了1层，再加被动1层 = 共2层 ✓
        //     [7,7] 双子星已在 GameEngine 加了3层，再加被动1层 = 共4层 ✓
        //     [1,7] 仅被动1层 ✓
        var isDoubleStar = (hands[0] == hands[1]);
        var isNewSeven   = (hands[0] == 7 && _prevHand0 != 7)
                        || (hands[1] == 7 && _prevHand1 != 7);
        if (!isDoubleStar && !isNewSeven && target.hp > 0) {
            target.addBuff(new PoisonBuff(1));
            trace('🥷 忍者给 ${target.name} 加 1 层中毒！');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // (3) 物法减伤：每层敌方毒 17%，超过 51% 后每层 +9%
    // ─────────────────────────────────────────────────────────────

    /**
     * 计算当前减伤百分比（0-100）
     */
    public function calcDamageReduction(engine:GameEngine):Int {
        if (engine == null || engine.turnManager == null) return 0;
        var totalPoison = 0;
        for (p in engine.turnManager.players) {
            if (p == this) continue; // 自己的毒不算
            if (p.hp <= 0) continue;
            var pb = p.getBuff("POISON");
            if (pb != null) totalPoison += pb.layers;
        }
        if (totalPoison <= 0) return 0;
        // 前3层每层15%（最高45%），超过45%后每层+10%（最高75%，即再加3层）
        if (totalPoison <= 3) {
            return totalPoison * 15; // 1层15%, 2层30%, 3层45%
        }
        // 超过3层后每层+10%，上限75%
        var extra = totalPoison - 3;
        if (extra > 3) extra = 3; // 最多再加3层×10%=30%
        return 45 + extra * 10;
    }

    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        var inputAmount = amount;
        // 真伤不减
        if (dmgType == PHYSICAL || dmgType == MAGIC) {
            var reduction = calcDamageReduction(GameEngine.instance);
            if (reduction > 0) {
                inputAmount = Std.int(amount * (100 - reduction) / 100);
                trace('🥷 忍者减伤：${amount} → ${inputAmount}（敌方毒层提供 ${reduction}% 减伤）');
            }
        }
        return super.handleIncomingDamage(attacker, inputAmount, dmgType);
    }

    // ─────────────────────────────────────────────────────────────
    // (2) 监听全场毒伤扣血 / 解毒事件 → 忍者回血
    // 用新增钩子：onAnyPoisonTick / onAnyPoisonCleared
    // ─────────────────────────────────────────────────────────────
    override public function onAnyPoisonTick(victim:Player, actualPoisonDamage:Int, engine:GameEngine):Void {
        if (victim == this) return; // 忍者自己中毒不触发
        if (actualPoisonDamage <= 0) return;
        trace('🥷 忍者监听毒伤：${victim.name} 扣 ${actualPoisonDamage} 毒血 → 忍者回 ${actualPoisonDamage}！');
        engine.applyRawHeal(this, actualPoisonDamage, SUPPLY, true);
    }

    override public function onAnyPoisonCleared(victim:Player, engine:GameEngine):Void {
        if (victim == this) return; // 自己解毒不触发
        trace('🥷 忍者监听解毒：${victim.name} 解了一层毒 → 忍者回 20！');
        engine.applyRawHeal(this, 20, SUPPLY, true);
    }

    // ─────────────────────────────────────────────────────────────
    // 忍者专属：[x,7] 被动 —— 7刚变出来时才触发（和[x,6]逻辑一样）
    // 记录上次碰手结束后的双手值，对比本次是否有"新变出来的7"
    // ─────────────────────────────────────────────────────────────
    private var _prevHand0:Int = 1; // 上次碰手结束后的左手值（初始[1,1]）
    private var _prevHand1:Int = 1;

    override public function onAfterTouchResolved():Void {
        var engine = GameEngine.instance;
        if (engine == null) return;

        // 检查是否有"本次新变出来的7"（上回合不是7，现在是7）
        var newSeven = (hands[0] == 7 && _prevHand0 != 7)
                    || (hands[1] == 7 && _prevHand1 != 7);

        // 更新记录
        _prevHand0 = hands[0];
        _prevHand1 = hands[1];

        if (!newSeven) return;

        var target = engine.findEnemyTarget(this);
        if (target == null || target.hp <= 0) return;
        trace('🥷 忍者 [x,7] 毒刃被动：7刚变出，额外给 ${target.name} 附加 1 层中毒！');
        target.addBuff(new PoisonBuff(1));
    }

    // ─────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────
    override public function getCustomDisplay():String {
        var reduction = calcDamageReduction(GameEngine.instance);
        return '🥷 当前物法减伤：<b>${reduction}%</b>（敌方毒层提供）';
    }

    override public function getSnapshotExtras():Array<String> {
        var reduction = calcDamageReduction(GameEngine.instance);
        return ['🥷减伤:${reduction}%'];
    }
}
