package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;

/**
 * 张飞 (坦克 | HP: 280)
 *
 * (1) 行动结束时补给 10 血（狂暴时翻倍 = 20）
 * (2) 受到物理伤害时，免疫"双手差值 × 10"的物理伤害（狂暴时翻倍）
 * (3) 三模态（任意时刻可切换，默认模态1）：
 *      ① 物伤×1.5
 *      ② 0.75倍伤害打两个敌人（1v1时只能用模态①或③）
 *      ③ 补给造成的物伤一半的血（RECOVERY，按actualDamage算）
 * (4) 每次回血(RECOVERY/SUPPLY) 或 受击/造伤(不含反弹) → +1层怒气
 *     每大回合上限+4层（超出就不再叠）
 *     ≥24层可主动进入【狂暴】3回合，扣24怒气
 *     狂暴期间：0用3回合（含进入前已有的0）；(1)+10血翻倍；(2)免伤×2；物伤再×1.5（叠加模态①=2.25）
 */
class ZhangFei extends Player {

    public var rage:Int = 0;            // 当前怒气
    public var rageAddedThisRound:Int = 0; // 本大回合已加怒气数（上限4）
    public var frenzyTurns:Int = 0;     // 狂暴剩余回合数（>0即狂暴中）
    public var modal:Int = 1;           // 当前模态（1/2/3）

    // 套娃保护
    private var _inModalEffect:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 560, camp);
    }

    inline function isFrenzied():Bool return frenzyTurns > 0;
    public function getIsFrenzied():Bool return frenzyTurns > 0;

    // ─────────────────────────────────────────────────────────────
    // (1) 行动结束补给10血（狂暴翻倍）
    // ─────────────────────────────────────────────────────────────
    override public function onTurnEnd() {
        super.onTurnEnd();
        var amount = isFrenzied() ? 20 : 10;
        if (this.hp > 0 && GameEngine.instance != null) {
            trace('🐗 张飞行动结束补给 ${amount} 血${isFrenzied() ? "（狂暴翻倍）" : ""}');
            GameEngine.instance.applyRawHeal(this, amount, SUPPLY, false);
            // isFromSkill=false 让"回血加怒"事件能触发自己
        }
        // 狂暴回合数 -1
        if (isFrenzied()) {
            frenzyTurns--;
            if (frenzyTurns == 0) {
                this.initTurns = 2; // 恢复默认
                trace('🐗 张飞狂暴结束！0使用回合数恢复为 2');
            } else {
                trace('🐗 张飞狂暴剩 ${frenzyTurns} 回合');
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // (2) 物伤免疫"双手差值×10"（狂暴翻倍）
    // ─────────────────────────────────────────────────────────────
    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        var inputAmount = amount;
        if (dmgType == PHYSICAL) {
            var diff = hands[0] - hands[1];
            if (diff < 0) diff = -diff;
            var immune = diff * 10;
            if (isFrenzied()) immune *= 2;
            if (immune > 0) {
                if (immune >= amount) {
                    trace('🐗 张飞免伤：理论扣 ${amount}，全部免疫（免疫值 ${immune}${isFrenzied() ? " 狂暴×2" : ""}）');
                    inputAmount = 0;
                } else {
                    inputAmount = amount - immune;
                    trace('🐗 张飞免伤：${amount} → ${inputAmount}（免疫 ${immune}${isFrenzied() ? " 狂暴×2" : ""}）');
                }
            }
        }
        var result = super.handleIncomingDamage(attacker, inputAmount, dmgType);
        // 受击加怒气（不含反弹—— attacker的反弹会再次进来，但ReflectBuff有_reflecting守卫所以一次完整反弹链最多触发一次受击）
        if (result.actualDamage > 0 || inputAmount > 0) {
            tryGainRage('受击');
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────
    // (3) 模态加成 + 触发模态效果
    // ─────────────────────────────────────────────────────────────
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (_inModalEffect) return baseAmount;
        if (type != PHYSICAL) return baseAmount;

        var amount = baseAmount;
        // 模态1：×1.5；模态2：×0.75；模态3：原值
        switch (modal) {
            case 1: amount = Std.int(amount * 1.5);
            case 2: amount = Std.int(amount * 0.75);
            case 3: amount = Std.int(amount);
        }
        // 狂暴：物伤再×1.5
        if (isFrenzied()) amount = Std.int(amount * 2);

        if (amount != baseAmount) {
            trace('🐗 张飞物伤加成：${baseAmount} → ${amount}（模态${modal}${isFrenzied() ? " + 狂暴" : ""}）');
        }
        return amount;
    }

    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (_inModalEffect) return;
        if (type != PHYSICAL) return;
        if (actualDamage <= 0) return;

        // 模态3：补给 actualDamage / 2 血（RECOVERY）
        if (modal == 3) {
            var heal = Std.int(actualDamage / 2);
            if (heal > 0) {
                trace('🐗 张飞模态③：造成 ${actualDamage} 物伤 → 回 ${heal} 血');
                engine.applyRawHeal(this, heal, RECOVERY, false);
            }
        }

        // 造伤加怒气
        tryGainRage('造伤');

        // 模态2 已经在攻击逻辑里处理打两人（用 useModalAttack 主动技），不在这里再追加
    }

    /**
     * 模态2：主动技能"0.75倍打两人"
     * 需要前端在攻击前主动调用本方法选目标；如果只有一个敌人，模态2 用本方法也只打一个
     * （为简单起见，本版本"模态2"在攻击事件里只走 calculateOutputDamage 加成0.75倍；
     *  "打两人"留作未来 2v2 时的扩展）
     */

    // ─────────────────────────────────────────────────────────────
    // (4) 怒气与狂暴
    // ─────────────────────────────────────────────────────────────

    /**
     * 尝试加1层怒气（受大回合4层上限保护）
     */
    private function tryGainRage(reason:String):Void {
        if (rageAddedThisRound >= 4) return;
        rage++;
        rageAddedThisRound++;
        trace('🐗 张飞获得 1 层怒气（${reason}），当前 ${rage}（本大回合 ${rageAddedThisRound}/4）');
    }

    /**
     * 监听全场回血事件：自己回血时加怒气
     */
    override public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {
        if (healer != this) return;
        if (amount <= 0) return;
        tryGainRage('回血');
    }

    /**
     * 大回合结束：怒气计数器重置
     */
    override public function onBigRoundEnd():Void {
        if (rageAddedThisRound > 0) {
            trace('🐗 张飞怒气计数重置（上回合获得 ${rageAddedThisRound}/4 层）');
        }
        rageAddedThisRound = 0;
    }

    /**
     * 主动进入狂暴
     */
    public function enterFrenzy(engine:GameEngine):String {
        if (isFrenzied()) return "错误：已在狂暴中，不能重复进入";
        if (rage < 24) return "错误：怒气不足24层（当前${rage}）";
        rage -= 24;
        frenzyTurns = 3;
        this.initTurns = 3; // 狂暴期间出0用3回合
        // 狂暴对已有0也生效：当前0的寿命+1
        if (hands[0] == 0 && zeroTurns0 > 0) zeroTurns0++;
        if (hands[1] == 0 && zeroTurns1 > 0) zeroTurns1++;
        trace('🐗🔥 张飞进入【狂暴】！消耗 24 怒气，剩 ${rage}。持续 3 回合。0使用回合数升级为3，已有0寿命+1');
        return "成功进入狂暴";
    }

    // ─────────────────────────────────────────────────────────────
    // 模态切换 / 狂暴 / 自描述 / handleAction
    // ─────────────────────────────────────────────────────────────
    public function setModal(m:Int):String {
        if (m < 1 || m > 3) return "错误：模态值应为 1-3";
        modal = m;
        trace('🐗 张飞切换为模态 ${m}');
        return "切换成功";
    }

    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        if (actionName == "setModal") return setModal(params.modal);
        if (actionName == "enterFrenzy") return enterFrenzy(engine);
        return super.handleAction(actionName, params, engine);
    }

    override public function getCustomDisplay():String {
        var modalLabels = ["模态①物伤×1.5", "模态②0.75倍打两人(1v1禁用)", "模态③造伤回血一半"];
        var modalStr = modalLabels[modal - 1];
        var rageStr = '怒气 <b>${rage}</b> (本回合${rageAddedThisRound}/4)';
        var frenzyStr = isFrenzied() ? ' | 🔥<b>狂暴剩${frenzyTurns}回合</b>' : '';
        return '🐗 ${modalStr} | ${rageStr}${frenzyStr}';
    }

    override public function getCustomActions():Array<CustomAction> {
        var actions:Array<CustomAction> = [];
        // 三个模态切换按钮
        actions.push({
            label: (modal == 1 ? "✓ " : "") + "模态①",
            color: modal == 1 ? "#52c41a" : "#8c8c8c",
            enabled: true,
            onClickJS: "Main.invokeAction(__IDX__, 'setModal', {modal:1})"
        });
        actions.push({
            label: (modal == 2 ? "✓ " : "") + "模态②(1v1禁用)",
            color: modal == 2 ? "#52c41a" : "#8c8c8c",
            enabled: true,
            onClickJS: "Main.invokeAction(__IDX__, 'setModal', {modal:2})"
        });
        actions.push({
            label: (modal == 3 ? "✓ " : "") + "模态③",
            color: modal == 3 ? "#52c41a" : "#8c8c8c",
            enabled: true,
            onClickJS: "Main.invokeAction(__IDX__, 'setModal', {modal:3})"
        });
        // 狂暴按钮
        if (rage >= 24 && !isFrenzied()) {
            actions.push({
                label: "🔥 进入狂暴",
                color: "#ff4d4f",
                enabled: true,
                onClickJS: "Main.invokeAction(__IDX__, 'enterFrenzy', {})"
            });
        }
        return actions;
    }

    override public function getSnapshotExtras():Array<String> {
        var extras = ['🐗模态${modal}', '怒气${rage}'];
        if (isFrenzied()) extras.push('🔥狂暴${frenzyTurns}');
        return extras;
    }
}
