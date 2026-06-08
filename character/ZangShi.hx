package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import model.ShieldType;

/**
 * 藏师（坦克 | HP 330）
 * (1) 受到的所有物理伤害减半（法术/真伤不减）
 * (2) 受到物理伤害减半结算后，反弹自身实际扣血量 50% 的物理伤害（与双5共用反弹机制）
 * (3) 自身回复量×2.5；自身获得护盾厚度×2
 * (4) 草莓蛋糕：场上每发生一次回血/获盾（每大回合上限8次），藏师获得 1 个蛋糕
 *     每 3 个蛋糕可对任一目标造成 10 点法伤 + 自身补给 10 血
 *     技能内产生的回血/获盾不计入（如毒伤反向、藏师自己补给）
 *     蛋糕无上限，藏师可在任意自己回合释放
 */
class ZangShi extends Player {

    public var cakes:Int = 0;
    public var cakeEventsThisRound:Int = 0; // 当前大回合已记录的事件数（上限8）

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 660, camp);
    }

    // ── (1) 物伤减半 ──
    // 这里在 calculateOutputDamage 不对，应该在受击时减半。最干净的方式是重写 handleIncomingDamage 之前的预处理，
    // 但 Player.handleIncomingDamage 太复杂，我们换一个思路：通过 Buff 永久挂在身上 → 在 onTakeDamage 钩子里减半
    // 这样不动 Player.hx 的核心逻辑
    // → 改为通过构造时挂一个永久"物伤减半 Buff"

    // 更简洁做法：直接在子类重写 handleIncomingDamage 也可以，但破坏封装
    // 选择：直接重写 handleIncomingDamage 的输入伤害量
    // 在父类调用时先把物伤减半，然后调父类

    // ── 选择 B：重写父类 handleIncomingDamage 入口，物伤减半后委托给父类 ──
    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        var inputAmount = amount;
        if (dmgType == PHYSICAL) {
            inputAmount = Std.int(amount / 2);
            trace('🛡️ 藏师物伤减半：${amount} → ${inputAmount}');
        }
        
        // 调父类正常走护盾/扣血
        var result = super.handleIncomingDamage(attacker, inputAmount, dmgType);

        // ── (2) 受到物伤后反弹"实际扣血量"的50% ──
        // 用 ReflectBuff 的静态守卫共用，防止与双5互相循环
        if (dmgType == PHYSICAL && result.actualDamage > 0 && attacker != null) {
            var _eng = GameEngine.instance;
            if (_eng != null && !_eng.isReflecting) {
                var reflectDmg = Std.int(Math.min(result.actualDamage * 0.5, 200)); // 反弹上限200
                if (reflectDmg > 0) {
                    // 反弹不杀人：最多打到1血
                    var cappedReflect = (attacker.hp - 1 > 0) ? Std.int(Math.min(reflectDmg, attacker.hp - 1)) : 0;
                    if (cappedReflect > 0) {
                    trace('🛡️ 藏师被动反弹：实际扣血 ${result.actualDamage} → 反弹 ${cappedReflect} 物伤给 ${attacker.name}！');
                    _eng.isReflecting = true;
                    attacker.handleIncomingDamage(this, cappedReflect, PHYSICAL);
                    _eng.isReflecting = false;
                    } // cappedReflect > 0
                }
            }
        }

        return result;
    }

    // ── (3) 回复×2.5 ──
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        var base    = super.calculateFinalHeal(baseAmount, type); // 含坦克加成
        var boosted = Math.ceil(base * 2.5);
        trace('🛡️ 藏师回复加成：${baseAmount} → ${boosted}');
        return boosted;
    }

    // ── (3) 护盾厚度×2 ──
    override public function addShield(type:ShieldType, amount:Int, duration:Int) {
    var boosted = amount * 2;
    trace('🛡️ 藏师护盾加成：${amount} → ${boosted}（${type}，${duration}回合）');
    super.addShield(type, boosted, duration);
    // 每次获得物理盾时，同时附加一半厚度的法术盾
    if (type == PHYSICAL) {
        var magicAmount = Std.int(boosted / 2);
        trace('🛡️ 藏师附加法术盾：${magicAmount}（物理盾的一半）');
        super.addShield(MAGIC, magicAmount, duration);
    }
}

    // ── (4) 草莓蛋糕：只监听"藏师身上"发生的事件 ──
    //  事件类型：
    //    - 藏师自己回血（任何HealType，但来自草莓蛋糕本身的 isFromSkill 跳过避免循环）
    //    - 藏师自己获盾
    //    - 藏师自己造成伤害（包括反弹），不含草莓蛋糕的法伤
    //  每大回合上限 8 次

    /**
     * 给自己加一个蛋糕（受上限保护，并打 trace）
     */
    private function gainOneCake(reason:String):Void {
        if (cakeEventsThisRound >= 8) {
            trace('🍰 草莓蛋糕本大回合已达上限（8次），不再产生。');
            return;
        }
        cakeEventsThisRound++;
        cakes++;
        trace('🍓 ${this.name} 草莓蛋糕 +1（${reason}）！蛋糕：${cakes} 个，本大回合 ${cakeEventsThisRound}/8。');
    }

    override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {
        if (healer != this) return; // 只听自己的回血
        if (_inCakeCast) return;     // 草莓蛋糕自身的补给不计入
        if (amount <= 0) return;
        gainOneCake('自身回复 ${amount} 血');
    }

    override public function onAnyShieldGained(target:Player, isFromSkill:Bool, engine:GameEngine):Void {
        if (target != this) return; // 只听自己的获盾
        gainOneCake('自身获得护盾');
    }

    // ── 监听"自己造成伤害"（包括反弹），不含草莓蛋糕法伤 ──
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (_inCakeCast) return; // 草莓蛋糕自己的法伤不算
        if (actualDamage <= 0 && damageBeforeShield <= 0) return;
        gainOneCake('自身造成 ${actualDamage} 伤害（${type}）');
    }

    // 标记：当前是否在草莓蛋糕的释放过程中，避免循环计数
    private var _inCakeCast:Bool = false;

    // ── (4) 大回合结束 → 重置计数 ──
    override public function onBigRoundEnd():Void {
        if (cakeEventsThisRound > 0) {
            trace('🔄 ${this.name} 草莓蛋糕计数重置（上回合计 ${cakeEventsThisRound}/8）。');
        }
        cakeEventsThisRound = 0;
    }

    /**
     * 主动释放草莓蛋糕：消耗 3*groupCount 个蛋糕，对 target 造成 10*groupCount 法伤，自身补给 10*groupCount 血
     * 由前端在藏师自己回合时调用
     */
    public function useCake(target:Player, groupCount:Int, engine:GameEngine):String {
        if (groupCount <= 0) return "错误：必须至少释放1组";
        var cost = 3 * groupCount;
        if (cakes < cost) return "错误：蛋糕不足（需要 ${cost} 个，当前 ${cakes} 个）";
        if (target == null || target.hp <= 0) return "错误：目标无效";

        var damage = 10 * groupCount;
        var supply = 10 * groupCount;

        cakes -= cost;
        trace('🍓 ${this.name} 消耗 ${cost} 个草莓蛋糕，对 ${target.name} 造成 ${damage} 法伤，并自身补给 ${supply} 血！');

        // 进入"草莓蛋糕释放"模式：本期间的自伤/自补不再触发蛋糕计数
        _inCakeCast = true;
        engine.applyDamage(this, target, damage, MAGIC);
        engine.applyRawHeal(this, supply, RECOVERY, false);
        _inCakeCast = false;

        return "蛋糕释放成功";
    }

    // ─── 自描述接口实现 ───
    override public function getCustomDisplay():String {
        return '🍓 ${cakes} 个 (本大回合已计 ${cakeEventsThisRound}/8)';
    }

    override public function getCustomActions():Array<CustomAction> {
        if (cakes < 3) return [];
        // 把蛋糕数量编进JS调用，避免JS层读取Haxe字段名不确定的问题
        return [{
            label: '使用蛋糕(${cakes}个)',
            color: "#eb2f96",
            enabled: true,
            onClickJS: 'openCakeDialog(__IDX__, ${cakes})'
        }];
    }

    override public function getSnapshotExtras():Array<String> {
        return ['🍓蛋糕:${cakes}'];
    }

    /**
     * 通用前端入口：处理蛋糕释放
     */
    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        if (actionName == "useCake") {
            // 期望 params: { targetIdx:Int, groupCount:Int }
            if (engine.turnManager == null) return "错误：无引擎";
            var targetIdx:Int = params.targetIdx;
            var groupCount:Int = params.groupCount;
            var target = engine.turnManager.players[targetIdx];
            return useCake(target, groupCount, engine);
        }
        return super.handleAction(actionName, params, engine);
    }
}
