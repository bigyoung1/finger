package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import model.ShieldType;

/**
 * 阴阳师（半肉 | HP: 120）
 *
 * 三种模态：阴 / 阳 / 人（默认：人）
 * 每轮到自己行动时，可切换一次模态。
 *
 * (阴) 所有输出 ×3.5（calculateOutputDamage）；
 *       所有「本该回复」的值改为造成等量×3.5的物伤；
 *       受到的物法真伤害 ×1.5。
 *
 * (阳) 所有回复 ×3.5（calculateFinalHeal）；
 *       所有「本该造成伤害」的值改为回复等量×3.5血量；
 *       受到的物法真伤害 ×1.5。
 *
 * (人) 输出 ×0.5；获得物法免伤 1/4（在 handleIncomingDamage 里实现）；
 *       所有回复 ×1.5。
 *
 * 特殊护盾（仅人→阴/阳时产生）：
 *   - 厚度 = 25 × 敌人数；每次「轮到自己行动前」-= 10 × 敌人数
 *   - 类型：物法盾（BOTH_PHYSICAL_MAGIC），真伤穿透
 *   - 切回人时：回复当前护盾剩余厚度的血量，护盾保留
 *   - 阴阳直接互切：护盾归零，自身受到「原护盾剩余 / 2」点物伤（纯标准流程，无额外倍率）
 *
 * 每次行动前可切换一次模态（切换后本轮不能再切）。
 */
class YinYangShi extends Player {

    /** 当前模态："yin" | "yang" | "ren" */
    public var modal:String = "ren";

    /** 特殊护盾当前剩余厚度（≥0） */
    public var specialShield:Int = 0;

    /** 本轮是否已切换过模态 */
    public var hasSwappedThisTurn:Bool = false;

    // 套娃保护：阴模态"回复→物伤"路径中，不能再触发自身输出倍率
    private var _inYinHealConvert:Bool = false;
    // 套娃保护：阳模态"物伤→回复"路径中，不能再触发自身回复倍率
    private var _inYangDmgConvert:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 240, camp);
    }

    // ─────────────────────────────────────────────────────────────
    // 工具：计算当前场上敌人数
    // ─────────────────────────────────────────────────────────────
    private function countEnemies():Int {
        var engine = GameEngine.instance;
        if (engine == null || engine.turnManager == null) return 1;
        var count = 0;
        for (p in engine.turnManager.players) {
            if (p == this) continue;
            if (p.hp <= 0) continue;
            if (p.camp == this.camp) continue;
            count++;
        }
        return count > 0 ? count : 1;
    }

    // ─────────────────────────────────────────────────────────────
    // 模态切换
    // ─────────────────────────────────────────────────────────────
    public function switchModal(newModal:String, engine:GameEngine):String {
        if (newModal != "yin" && newModal != "yang" && newModal != "ren") {
            return "错误：未知模态 " + newModal;
        }
        if (newModal == modal) return "错误：当前已是该模态";
        if (hasSwappedThisTurn) return "错误：本回合已切换过模态，不能再切";

        var oldModal = modal;
        hasSwappedThisTurn = true;

        // ── 情况A：阴/阳 直接互切 ──
        if ((oldModal == "yin" || oldModal == "yang") && (newModal == "yin" || newModal == "yang")) {
            var shieldBefore = specialShield;
            var penalty = Std.int(shieldBefore / 2);
            specialShield = 0;
            modal = newModal;
            if (shieldBefore == 0) {
                // 特殊护盾为0时，额外扣除 25×敌人数 的物伤
                var enemies = countEnemies();
                var extraPenalty = 25 * enemies;
                trace('☯️ 阴阳直接互切！特殊护盾已为0，额外惩罚 ${extraPenalty} 点物伤（25×敌人数${enemies}）。');
                var result = this.handleIncomingDamage(null, extraPenalty, PHYSICAL);
                trace('☯️ 互切惩罚实际扣血：${result.actualDamage}');
            } else {
                trace('☯️ 阴阳直接互切！特殊护盾 ${shieldBefore} 归零，自身受到 ${penalty} 点物伤。');
                if (penalty > 0) {
                    var result = this.handleIncomingDamage(null, penalty, PHYSICAL);
                    trace('☯️ 互切自伤实际扣血：${result.actualDamage}');
                }
            }
            trace('☯️ 切换至【${newModal == "yin" ? "阴" : "阳"}】模态。');
            return "切换成功";
        }

        // ── 情况B：人 → 阴/阳（获得特殊护盾） ──
        if (oldModal == "ren" && (newModal == "yin" || newModal == "yang")) {
            modal = newModal;
            var enemies = countEnemies();
            var shieldAmount = 25 * enemies;
            specialShield = shieldAmount;
            trace('☯️ 人→${newModal == "yin" ? "阴" : "阳"}！获得特殊物法护盾 ${shieldAmount}（敌人数 ${enemies}×25）。');
            return "切换成功";
        }

        // ── 情况C：阴/阳 → 人（回复护盾厚度的血量） ──
        if ((oldModal == "yin" || oldModal == "yang") && newModal == "ren") {
            var healAmount = specialShield;
            modal = newModal;
            trace('☯️ ${oldModal == "yin" ? "阴" : "阳"}→人！回复当前特殊护盾剩余 ${healAmount} 点血量，护盾保留。');
            if (healAmount > 0) {
                // 用 applyRawHeal 避免触发"阳模态回复→伤害"的套娃（此时已切回人）
                engine.applyRawHeal(this, healAmount, RECOVERY, false);
            }
            return "切换成功";
        }

        modal = newModal;
        return "切换成功";
    }

    // ─────────────────────────────────────────────────────────────
    // 每次轮到自己行动前：特殊护盾 -10×敌人数，重置本轮切换标记
    // 通过重写 onTurnEnd 的对称钩子实现：
    // TurnManager 在 onTurnStart 之前已处理 zeroTurns；
    // 我们借用 onAfterTouchResolved 不够，改为监听大回合事件不准确。
    // 最干净的方式：重写 onTurnEnd 末尾追加，但那是"行动结束"。
    // "行动前"扣盾逻辑放在 handleAction("onTurnBegin") 由前端在每次轮到我时调用？
    // → 更简洁：重写 shouldSkipZeroTurnsDecrement（TurnManager在onTurnStart内调用），
    //   借此时机扣盾并重置标记。这个钩子在每次轮到自己时都会被调用（哪怕返回false）。
    // ─────────────────────────────────────────────────────────────
    override public function shouldSkipZeroTurnsDecrement():Bool {
        // 每次轮到自己行动前：
        // 1. 重置本轮模态切换标记
        hasSwappedThisTurn = false;
        // 2. 如果处于阴/阳模态，特殊护盾 -= 10×敌人数（最低归0）
        if (modal == "yin" || modal == "yang") {
            var enemies = countEnemies();
            var decay = 10 * enemies;
            if (specialShield > 0) {
                specialShield = Std.int(Math.max(0, specialShield - decay));
                trace('☯️ 阴阳师特殊护盾衰减 ${decay}（敌人×10），剩余 ${specialShield}。');
            }
        }
        return false; // 不影响 zeroTurns 递减逻辑
    }

    // ─────────────────────────────────────────────────────────────
    // (阴/阳) 受到的物法真伤害 ×1.5
    // (人)     物法伤害 1/4 免伤
    // ─────────────────────────────────────────────────────────────
    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        var inputAmount = amount;

        if (modal == "yin" || modal == "yang") {
            // 物法真伤都 ×1.5
            var boosted = Std.int(amount * 1.5);
            trace('☯️ 阴阳师【${modal == "yin" ? "阴" : "阳"}】受到 ${dmgType} 伤害，${amount} → ${boosted}（×1.5）');
            inputAmount = boosted;
        } else if (modal == "ren") {
            if (dmgType == PHYSICAL || dmgType == MAGIC || dmgType == TRUE) {
                // 1/4 免伤：实际受到 75%
                var reduced = Std.int(amount * 3 / 4);
                trace('☯️ 阴阳师【人】受到 ${dmgType} 伤害，${amount} → ${reduced}（物法真伤减少1/4）');
                inputAmount = reduced;
            }
        }

        // 特殊护盾：在标准护盾之前先用特殊护盾抵挡物法伤害（真伤穿透）
        if (inputAmount > 0 && specialShield > 0 && dmgType != TRUE) {
            var absorbed = Std.int(Math.min(specialShield, inputAmount));
            specialShield -= absorbed;
            inputAmount -= absorbed;
            trace('☯️ 特殊护盾抵挡 ${absorbed} 点伤害，剩余 ${specialShield}。');
        }

        return super.handleIncomingDamage(attacker, inputAmount, dmgType);
    }

    // ─────────────────────────────────────────────────────────────
    // 输出倍率
    // 阴：×3.5
    // 阳：伤害→回复（在 onAfterDealtDamage 处理，这里返回0让伤害不落地）
    // 人：×0.5
    // ─────────────────────────────────────────────────────────────
    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (_inYinHealConvert || _inYangDmgConvert) return baseAmount;

        switch (modal) {
            case "yin":
                var boosted = Std.int(baseAmount * 3.5);
                trace('☯️ 阴模态输出 ×3.5：${baseAmount} → ${boosted}');
                return boosted;
            case "yang":
                // 记录原始 baseAmount，供 onAfterDealtDamage 转为回复用
                _pendingYangBase = baseAmount;
                trace('☯️ 阳模态：伤害将转为回复，输出置0（基础值 ${baseAmount} 将×3.5回复）');
                return 0;
            case "ren":
                var halved = Std.int(baseAmount * 0.5);
                trace('☯️ 人模态输出 ×0.5：${baseAmount} → ${halved}');
                return halved;
            case _:
                return baseAmount;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 回复倍率
    // 阴：回复→物伤（在 onAfterHeal 处理，这里返回0让血量不回）
    // 阳：×3.5
    // 人：×1.5
    // ─────────────────────────────────────────────────────────────
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        if (_inYinHealConvert || _inYangDmgConvert) return baseAmount;

        switch (modal) {
            case "yin":
                _pendingYinBase = baseAmount;
                trace('☯️ 阴模态：回复将转为物伤，拦截为0（基础值 ${baseAmount} 将×3.5转为物伤）');
                return 0; // 不实际回血；GameEngine.applyHeal 会在actualHeal=0时仍调 onAfterHeal
            case "yang":
                var base    = super.calculateFinalHeal(baseAmount, type); // 含坦克加成
                var boosted = Math.ceil(base * 3.5);
                trace('☯️ 阳模态回复 ×3.5：${base} → ${boosted}');
                return boosted;
            case "ren":
                var base2    = super.calculateFinalHeal(baseAmount, type);
                var boosted2 = Math.ceil(base2 * 1.5);
                trace('☯️ 人模态回复 ×1.5：${base2} → ${boosted2}');
                return boosted2;
            case _:
                return super.calculateFinalHeal(baseAmount, type);
        }
    }

    private var _pendingYangBase:Int = 0; // 阳模态记录原始 baseAmount（calculateOutputDamage 写入）

    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (_inYangDmgConvert || _inYinHealConvert) return;

        if (modal == "yang" && _pendingYangBase > 0) {
            var healAmount = Std.int(_pendingYangBase * 3.5);
            trace('☯️ 阳模态：本次「基础」伤害 ${_pendingYangBase} × 3.5 = ${healAmount}，转为回复！');
            _pendingYangBase = 0;
            _inYangDmgConvert = true;
            engine.applyRawHeal(this, healAmount, RECOVERY, false);
            _inYangDmgConvert = false;
        } else {
            _pendingYangBase = 0;
        }
    }

    private var _pendingYinBase:Int = 0; // 阴模态记录原始 baseAmount（calculateFinalHeal 写入）

    override public function onAfterHeal(actualHeal:Int, type:HealType, engine:GameEngine):Void {
        if (_inYinHealConvert || _inYangDmgConvert) return;

        if (modal == "yin" && _pendingYinBase > 0) {
            var dmgAmount = Std.int(_pendingYinBase * 3.5);
            var enemy = engine.findEnemyTarget(this);
            if (enemy != null) {
                trace('☯️ 阴模态：本次「基础」回复 ${_pendingYinBase} × 3.5 = ${dmgAmount}，转为物伤！');
                _pendingYinBase = 0;
                _inYinHealConvert = true;
                engine.applyRawDamage(this, enemy, dmgAmount, PHYSICAL);
                _inYinHealConvert = false;
            } else {
                _pendingYinBase = 0;
            }
        }
    }
    // ─────────────────────────────────────────────────────────────
    // 重写 handleAction：模态切换 + 前端调用入口
    // ─────────────────────────────────────────────────────────────
    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        if (actionName == "switchModal") {
            return switchModal(params.modal, engine);
        }
        return super.handleAction(actionName, params, engine);
    }

    // ─────────────────────────────────────────────────────────────
    // 自描述接口
    // ─────────────────────────────────────────────────────────────
    override public function getCustomDisplay():String {
        var modalName = switch (modal) {
            case "yin": "☯️阴（输出×3.5，回复→物伤，受伤×1.5）";
            case "yang": "☯️阳（回复×3.5，伤害→回复，受伤×1.5）";
            case "ren": "☯️人（输出×0.5，回复×1.5，物法真伤-1/4）";
            case _: "未知";
        }
        var shieldStr = (modal == "yin" || modal == "yang") ? ' | 特殊护盾 <b>${specialShield}</b>' : '';
        var swapStr = hasSwappedThisTurn ? " | 本回合已切换" : "";
        return '${modalName}${shieldStr}${swapStr}';
    }

    override public function getCustomActions():Array<CustomAction> {
        var actions:Array<CustomAction> = [];
        var canSwap = !hasSwappedThisTurn;

        actions.push({
            label: (modal == "yin" ? "✓ " : "") + "☯ 阴",
            color: modal == "yin" ? "#722ed1" : (canSwap ? "#8c8c8c" : "#3d3d3d"),
            enabled: canSwap && modal != "yin",
            onClickJS: "Main.invokeAction(__IDX__, 'switchModal', {modal:'yin'})"
        });
        actions.push({
            label: (modal == "yang" ? "✓ " : "") + "☯ 阳",
            color: modal == "yang" ? "#fa8c16" : (canSwap ? "#8c8c8c" : "#3d3d3d"),
            enabled: canSwap && modal != "yang",
            onClickJS: "Main.invokeAction(__IDX__, 'switchModal', {modal:'yang'})"
        });
        actions.push({
            label: (modal == "ren" ? "✓ " : "") + "☯ 人",
            color: modal == "ren" ? "#52c41a" : (canSwap ? "#8c8c8c" : "#3d3d3d"),
            enabled: canSwap && modal != "ren",
            onClickJS: "Main.invokeAction(__IDX__, 'switchModal', {modal:'ren'})"
        });
        return actions;
    }

    override public function getSnapshotExtras():Array<String> {
        var extras = ['☯️模态:${modal}'];
        if (specialShield > 0) extras.push('特殊盾:${specialShield}');
        return extras;
    }
}
