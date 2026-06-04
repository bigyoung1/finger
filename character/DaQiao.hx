package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import buffs.InvincibleBuff;

/**
 * 大乔（半肉 | HP: 60）
 * (1) 主动抢夺全场任意"回复"行为的50%（仅RECOVERY，补给不可抢）
 *     每次回复事件发生后5秒内可选择抢夺，不抢就放弃
 *     自己回血不能抢自己的；先到先得；友方也可抢
 * (2) 造成物伤时回复50%伤害值的血量（RECOVERY类型，可解毒，可被其他大乔抢）
 * (3) 进化为神大乔：当前HP突破300后，可选择扣300血进化
 *     进化效果：废弃(4)，每次抢夺额外+10血，物伤×1.5，受物伤-1/4
 * (4) 复活甲：死后获得InvincibleBuff 2回合，之后以50血复活（仅限一次）
 *     变神大乔后废弃
 */
class DaQiao extends Player {

    public var isGodForm:Bool = false;       // 是否已进化为神大乔
    public var hasRevived:Bool = false;      // 是否已经用过复活甲
    private var _pendingRevive:Bool = false; // 标记"死后需要触发复活"

    // 冷却：记录"本轮已抢过的玩家"（key=player id），当该玩家下次行动时解除
    private var _stealCooldown:Map<String, Bool> = new Map<String, Bool>();

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 60, camp);
    }

    /**
     * (1) 监听全场回复事件，触发前端"抢夺"弹窗
     */
    override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {
        if (isFromSkill) return;
        if (type != RECOVERY) return;
        if (healer == this) return;
        if (amount <= 0) return;
        if (hp <= 0 && !_pendingRevive) return;

        var steal = calcStealAmount(amount);
        if (steal <= 0) return;

        // 找到自己和healer在players数组里的索引，通知前端
        var myIdx = -1;
        var healerIdx = -1;
        if (engine.turnManager != null) {
            var players = engine.turnManager.players;
            for (i in 0...players.length) {
                if (players[i] == this) myIdx = i;
                if (players[i] == healer) healerIdx = i;
            }
        }
        if (myIdx < 0 || healerIdx < 0) return;

        // 用数组索引作为冷却key（比id更可靠，同角色多实例也不会碰撞）
        var cooldownKey = Std.string(healerIdx);
        // 冷却检查：本轮已抢过该玩家，直接跳过
        if (_stealCooldown.exists(cooldownKey) && _stealCooldown.get(cooldownKey)) return;
        // 立刻标记冷却，防止同一大回合内同一人的多次回血重复触发弹窗
        _stealCooldown.set(cooldownKey, true);
        trace('🎯 大乔感知到 ${healer.name} 回复了 ${amount} 血，可抢夺 ${steal} 血！（5秒内）');
        // 通知前端弹窗（非阻塞，游戏继续）
        js.Syntax.code("if(typeof showStealPrompt !== 'undefined') showStealPrompt({0},{1},{2})",
            myIdx, healerIdx, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (type != PHYSICAL || actualDamage <= 0) return;
        var healAmount = Std.int(actualDamage * 0.5);
        if (healAmount <= 0) return;
        trace('🌸 大乔造成 ${actualDamage} 物伤，回复 ${healAmount} 血（RECOVERY）');
        engine.applyHeal(this, healAmount, RECOVERY);
    }

    // ─────────────────────────────────────────────────────────────
    // (3) 神大乔：物伤×1.5
    // ─────────────────────────────────────────────────────────────
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (isGodForm && type == PHYSICAL) {
            var boosted = Std.int(baseAmount * 1.5);
            trace('👑 神大乔物伤加成：${baseAmount} → ${boosted}');
            return boosted;
        }
        return baseAmount;
    }

    // ─────────────────────────────────────────────────────────────
    // (3) 神大乔：受到物伤减少1/4（即乘0.75）
    // ─────────────────────────────────────────────────────────────
    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        var inputAmount = amount;
        if (isGodForm && dmgType == PHYSICAL) {
            inputAmount = Std.int(amount * 3 / 4);
            trace('👑 神大乔减伤：${amount} → ${inputAmount}（物伤减1/4）');
        }
        return super.handleIncomingDamage(attacker, inputAmount, dmgType);
    }

    // ─────────────────────────────────────────────────────────────
    // (4) 复活甲：tryRevive 钩子（任何时候 HP<=0 时 TurnManager 会调用）
    // ─────────────────────────────────────────────────────────────
    override public function tryRevive(engine:GameEngine):Bool {
        // 神大乔/已用过复活甲 → 真的死
        if (isGodForm || hasRevived) return false;

        hasRevived = true;
        this.hp = 1; // 临时挂血（无敌期内反正不掉），无敌结束后由 onTurnEnd 弹回50
        _pendingRevive = true;
        this.addBuff(new InvincibleBuff(2));
        trace('🛡️✨ 【大乔复活甲】死后无敌2回合，期满复活！');
        return true;
    }

    override public function onTurnEnd() {
        // 检查复活完成：如果 _pendingRevive 且无敌结束 → 弹回50血
        if (_pendingRevive) {
            var inv = this.getBuff("INVINCIBLE");
            if (inv == null || inv.layers <= 0) {
                this.hp = 50;
                _pendingRevive = false;
                trace('🌸✨ 大乔无敌结束，以 50 血复活！');
            }
        }
        super.onTurnEnd();
    }

    // ─────────────────────────────────────────────────────────────
    // 进化检测：在每次回血后检查（由 Main.render 调用 checkEvolution）
    // ─────────────────────────────────────────────────────────────

    /**
     * 检查是否满足进化条件（当前HP > 300）
     * 满足时由前端给玩家弹进化确认框，玩家确认后调 evolve()
     */
    public function canEvolve():Bool {
        return !isGodForm && !hasRevived && hp > 300;
    }

    /**
     * 执行进化：扣300血，切换为神大乔形态
     */
    public function evolve():String {
        if (!canEvolve()) return "错误：不满足进化条件";
        isGodForm = true;
        hp -= 300;
        hasRevived = true; // 废弃复活甲
        trace('👑✨ 大乔进化为【神大乔】！扣除300血，HP → ${hp}。获得：物伤×1.5、物免1/4、每次抢夺额外+10血。复活甲已废弃。');
        return "进化成功";
    }

    /**
     * 计算本次抢夺可获得的血量（总回血的50%，神大乔额外+10）
     * @param healerCurrentHp 被抢者当前HP（防止抢了又超出被抢者剩余回血量）
     * @param netHeal 本次净回血量（解毒后的实际回血，非原始值）
     */
    public function calcStealAmount(netHeal:Int):Int {
        if (netHeal <= 0) return 0;
        var steal = Std.int(netHeal * 0.5);
        if (isGodForm) steal += 10;
        return steal;
    }

    /**
     * 执行抢夺（由 Main.doSteal 调用）
     * @param healer 被抢者
     * @param netHeal 本次净回血量（由事件传过来）
     * @param engine 引擎
     */
    public function doSteal(healer:Player, netHeal:Int, engine:GameEngine):String {
        if (healer == this) return "错误：不能抢自己的回血";
        var steal = calcStealAmount(netHeal);
        if (steal <= 0) return "本次无可抢夺";

        healer.hp -= steal;
        trace('🎯 大乔${isGodForm ? "(神)" : ""}抢夺了 ${healer.name} 的 ${steal} 血！');
        // doSteal 里也用索引作为key（与 onAnyHealHappened 保持一致）
        if (engine.turnManager != null) {
            var ps = engine.turnManager.players;
            for (i in 0...ps.length) {
                if (ps[i] == healer) { _stealCooldown.set(Std.string(i), true); break; }
            }
        }

        // 大乔自己获得这部分：用 SUPPLY 类型（不解毒、不被其他大乔再抢、不更新孙悟空y）
        engine.applyRawHeal(this, steal, SUPPLY, true);

        return "抢夺成功";
    }

    // ─────────────────────────────────────────────────────────────
    // 自描述接口
    // ─────────────────────────────────────────────────────────────
    override public function getCustomDisplay():String {
        if (isGodForm) {
            return '👑 【神大乔】物伤×1.5 | 物免1/4 | 抢夺额外+10血';
        }
        // 复活甲已用 → 已经废弃进化（按规则也再回不到完整生命周期，但实际上玩家仍可进化神大乔）
        // 注意：canEvolve() 检查了 hasRevived，所以复活甲用过后无法进化
        if (hasRevived) {
            return '🌸 复活甲已用，不能再进化（已废弃）';
        }
        var evolvable = hp > 300;
        return '🌸 ${evolvable ? "⚡ 血量已突破300！可进化为神大乔" : "HP>300可进化为神大乔"} | 复活甲待机';
    }

    override public function getCustomActions():Array<CustomAction> {
        var actions:Array<CustomAction> = [];
        if (canEvolve()) {
            actions.push({
                label: "👑 进化为神大乔",
                color: "#722ed1",
                enabled: true,
                onClickJS: "Main.invokeAction(__IDX__, 'evolve', {})"
            });
        }
        return actions;
    }

    override public function getSnapshotExtras():Array<String> {
        var extras = [];
        if (isGodForm) extras.push('👑神大乔');
        else {
            if (hasRevived) extras.push('复活甲已用');
        }
        return extras;
    }

    /**
     * 通用前端入口：处理进化、抢夺
     */
    /**
     * 监听：某玩家开始行动 → 解除对该玩家的抢夺冷却
     */
    override public function onAnyTurnStart(actor:Player, engine:GameEngine):Void {
        if (engine.turnManager == null) return;
        var ps = engine.turnManager.players;
        for (i in 0...ps.length) {
            if (ps[i] == actor) {
                var key = Std.string(i);
                if (_stealCooldown.exists(key) && _stealCooldown.get(key)) {
                    _stealCooldown.set(key, false);
                    trace('🎯 大乔对 ' + actor.name + '(idx=' + i + ') 的抢夺冷却解除。');
                }
                break;
            }
        }
    }

    override public function onBigRoundEnd():Void {
        _stealCooldown = new Map<String, Bool>();
        trace('🎯 大乔：大回合结束，抢夺冷却全部重置。');
    }

    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        if (actionName == "evolve") {

            return evolve();}
        
        if (actionName == "doSteal") {
            // 期望 params: { healerIdx:Int, netHeal:Int }
            if (engine.turnManager == null) return "错误：无引擎";
            var healerIdx:Int = params.healerIdx;
            var netHeal:Int = params.netHeal;
            var healer = engine.turnManager.players[healerIdx];
            return doSteal(healer, netHeal, engine);
        }
        return super.handleAction(actionName, params, engine);
    

}
}