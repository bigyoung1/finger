package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import model.ShieldType;
import model.ShieldInstance;

/**
 * 功夫熊猫（坦克/半肉 | HP 230）
 * 专属系统：金刚罩（独立于普通护盾的额外血条）。
 * - 开局 1 个 150HP 金刚罩；主动技能扣 110HP 新增 1 个 70HP 金刚罩，最多 7 个。
 * - 可随时选择最多 4 个抗伤单位（本体/金刚罩）参与抗伤，伤害在这些单位间平摊。
 * - 金刚罩可抵挡所有伤害；抵挡真实伤害时，对金刚罩伤害 ×1.5。
 * - 分配到某个金刚罩的伤害，溢出部分作废，不转移到本体/其他罩。
 * - 对攻击者来说，经过普通护盾后落到本体/金刚罩的伤害都算“实际打中”，可触发小乔等“打多少补给多少”。
 * - 回血流：回血时所有金刚罩共同分配固定 60 点补给修复。
 */
class KungFuPanda extends Player {
    public var kingShields:Array<Int> = [];
    public var pandaMode:String = "heal"; // heal=回血流, shield=回盾流
    public var pandaGuards:Array<Int> = [0]; // -1=本体，>=0=金刚罩下标；最多4个

    private var _lastHealBase:Int = 0;
    private var _lastHealMode:String = "heal";
    private var _healingKingShields:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 230, camp);
        kingShields.push(150);
        pandaGuards = [0];
    }

    inline function aliveShieldCount():Int {
        var n = 0;
        for (v in kingShields) if (v > 0) n++;
        return n;
    }

    function thinnestShieldIdx():Int {
        var best = -1;
        var bestVal = 999999;
        for (i in 0...kingShields.length) {
            if (kingShields[i] > 0 && kingShields[i] < bestVal) {
                best = i;
                bestVal = kingShields[i];
            }
        }
        return best;
    }

    function cleanKingShields():Void {
        var i = kingShields.length - 1;
        while (i >= 0) {
            if (kingShields[i] <= 0) kingShields.splice(i, 1);
            i--;
        }
        normalizePandaGuards();
    }

    function normalizePandaGuards():Void {
        var seen = new Map<Int, Bool>();
        var fixed:Array<Int> = [];
        for (g in pandaGuards) {
            if (g != -1 && (g < 0 || g >= kingShields.length)) continue;
            if (seen.exists(g)) continue;
            seen.set(g, true);
            fixed.push(g);
            if (fixed.length >= 4) break;
        }
        if (fixed.length == 0) {
            var idx = thinnestShieldIdx();
            fixed.push(idx >= 0 ? idx : -1);
        }
        pandaGuards = fixed;
    }

    function healMultiplier():Float {
        var n = aliveShieldCount();
        if (n <= 0) return 3.0;
        if (n == 1) return 2.5;
        if (n == 2) return 2.25;
        return 2.0;
    }

    function repairAllKingShieldsShared(totalAmount:Int):Void {
        if (totalAmount <= 0 || kingShields.length == 0) return;
        var n = kingShields.length;
        var base = Std.int(totalAmount / n);
        var rem = totalAmount % n;
        for (i in 0...n) {
            var amount = base + (i < rem ? 1 : 0); // 保证总修复量严格等于 totalAmount
            if (amount <= 0) continue;
            kingShields[i] += amount;
            trace('🐼 回血流：金刚罩${i + 1} 获得 ${amount} 点补给修复（总量${totalAmount}/${n}个罩），当前 ${kingShields[i]}');
        }
    }

    // ── 模态加成 ──
    override public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        var base = super.calculateFinalHeal(baseAmount, type);
        _lastHealBase = baseAmount;
        _lastHealMode = pandaMode;

        if (pandaMode == "heal") {
            var m = healMultiplier();
            var boosted = Math.ceil(base * m);
            trace('🐼 回血流：本体回复 ${base} × ${m} = ${boosted}（金刚罩数 ${aliveShieldCount()}）');
            return boosted;
        }

        trace('🐼 回盾流：本体回复不额外加成，${baseAmount} → ${base}');
        return base;
    }

    override public function onAfterHeal(actualHeal:Int, type:HealType, engine:GameEngine):Void {
        if (_healingKingShields || actualHeal <= 0) return;
        if (_lastHealBase <= 0) return;

        _healingKingShields = true;
        if (_lastHealMode == "heal") {
            // 回血流：所有金刚罩共同分配固定 60 点补给修复（不触发大乔/悟空/解毒）
            repairAllKingShieldsShared(60);
        } else {
            // 回盾流：所有金刚罩获得 原始回复 + 10 的修复
            var amount = _lastHealBase + 10;
            for (i in 0...kingShields.length) {
                kingShields[i] += amount;
                trace('🐼 回盾流：金刚罩${i + 1} 获得 ${amount} 点补给修复，当前 ${kingShields[i]}');
            }
        }
        _healingKingShields = false;
    }

    override public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        if (type != PHYSICAL) return baseAmount;
        if (pandaMode == "heal") {
            var reduced = Std.int(baseAmount * 0.5);
            trace('🐼 回血流：物理攻击 ${baseAmount} ×0.5 = ${reduced}');
            return reduced;
        }
        var boosted = Std.int(baseAmount * 2);
        trace('🐼 回盾流：物理攻击 ${baseAmount} ×2 = ${boosted}');
        return boosted;
    }

    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (pandaMode == "heal" && type == PHYSICAL && actualDamage > 0) {
            var supply = actualDamage * 2;
            trace('🐼 回血流：造成 ${actualDamage} 物伤 → 获得 ${supply} 补给');
            engine.applyRawHeal(this, supply, SUPPLY, true);
        }
    }

    override public function addShield(type:ShieldType, amount:Int, duration:Int):Void {
        if (pandaMode == "heal" && type == PHYSICAL) {
            var boosted = amount * 2;
            trace('🐼 回血流：获得物理护盾 ${amount}/${duration} → ${boosted}/${duration + 1}');
            super.addShield(type, boosted, duration + 1);
            return;
        }
        super.addShield(type, amount, duration);
    }

    // ── 金刚罩抗伤 ──
    override public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):model.Player.DamageResult {
        if (amount <= 0) return { damageBeforeShield: 0, actualDamage: 0 };
        var __helpBeforeHp = this.hp;
        var __helpBeforeShields:Array<ShieldInstance> = [];
        if (GameEngine.instance != null) {
            for (s in this.shieldList) __helpBeforeShields.push(new ShieldInstance(s.type, s.amount, s.duration));
        }
        var finalDamage = amount;

        // 攻击者 buff（与基类逻辑对齐）
        if (attacker != null && (GameEngine.instance == null || !GameEngine.instance._skipAttackerDealBuffs)) {
            for (b in attacker.buffList) finalDamage = b.onDealDamage(attacker, this, finalDamage, dmgType);
            attacker.cleanEmptyBuffs();
        } else if (attacker != null) {
            attacker.cleanEmptyBuffs();
        }

        // 自己的防御 Buff；真伤穿透常规防御 Buff
        if (dmgType != TRUE) {
            for (b in buffList) finalDamage = b.onTakeDamage(this, attacker, finalDamage, dmgType);
            if (finalDamage <= 0) {
                cleanEmptyBuffs();
                return { damageBeforeShield: 0, actualDamage: 0 };
            }
        }

        var damageBeforeShield = finalDamage;

        // 普通护盾先照常抵挡，剩余部分再交给本体/金刚罩抗伤组。
        while (finalDamage > 0) {
            var valid:Array<ShieldInstance> = [];
            for (shield in shieldList) {
                if (shield.amount <= 0) continue;
                var canBlock = false;
                switch (dmgType) {
                    case PHYSICAL:
                        if (shield.type == PHYSICAL || shield.type == BOTH_PHYSICAL_MAGIC || shield.type == TRUE) canBlock = true;
                    case MAGIC:
                        if (shield.type == MAGIC || shield.type == BOTH_PHYSICAL_MAGIC || shield.type == TRUE) canBlock = true;
                    case TRUE:
                        if (shield.type == TRUE) canBlock = true;
                }
                if (canBlock) valid.push(shield);
            }
            if (valid.length == 0) break;
            valid.sort(function(a, b) return a.duration - b.duration);
            var s = valid[0];
            if (s.amount >= finalDamage) {
                s.amount -= finalDamage;
                finalDamage = 0;
            } else {
                finalDamage -= s.amount;
                s.amount = 0;
            }
            var i = shieldList.length - 1;
            while (i >= 0) { if (shieldList[i].amount <= 0) shieldList.splice(i, 1); i--; }
        }

        if (finalDamage <= 0) return { damageBeforeShield: damageBeforeShield, actualDamage: 0 };

        cleanKingShields();
        normalizePandaGuards();
        var landedDamage = finalDamage; // 对攻击者来说，落到本体/金刚罩的都算打中。

        var guards = pandaGuards.copy();
        var n = guards.length;
        var baseShare = Std.int(finalDamage / n);
        var rem = finalDamage % n;
        var bodyDamage = 0;

        for (i in 0...guards.length) {
            var g = guards[i];
            var share = baseShare + (i < rem ? 1 : 0);
            if (share <= 0) continue;

            if (g == -1) {
                bodyDamage += share;
                trace('🐼 本体参与抗伤，分摊 ${share} 点伤害');
            } else if (g >= 0 && g < kingShields.length) {
                var shieldDamage = (dmgType == TRUE) ? Math.ceil(share * 1.5) : share;
                var before = kingShields[g];
                var lost = Std.int(Math.min(before, shieldDamage));
                kingShields[g] -= lost;
                trace('🐼 金刚罩${g + 1} 分摊 ${share} 伤害${dmgType == TRUE ? "（真伤打罩×1.5=" + shieldDamage + "）" : ""}，扣 ${lost}，溢出作废。剩 ${kingShields[g]}');
            }
        }

        if (bodyDamage > 0) {
            this.hp -= bodyDamage;
            trace('🐼 本体合计扣血 ${bodyDamage}');
        }
        cleanKingShields();
        if (GameEngine.instance != null) {
            var src = attacker != null ? attacker.name : "伤害";
            GameEngine.instance.maybeRegisterHelpTankEvent(this, attacker, damageBeforeShield, landedDamage, dmgType, src, __helpBeforeHp, __helpBeforeShields);
        }
        return { damageBeforeShield: damageBeforeShield, actualDamage: landedDamage };
    }

    // ── 主动技能 / 前端操作 ──
    public function makeKingShield():String {
        cleanKingShields();
        if (kingShields.length >= 7) return "错误：金刚罩已达上限7个";
        if (hp <= 110) return "错误：血量不足，无法扣110血获得金刚罩";
        hp -= 110;
        kingShields.push(70);
        var newIdx = kingShields.length - 1;
        if (pandaGuards.indexOf(newIdx) < 0) {
            if (pandaGuards.length >= 4) pandaGuards.shift();
            pandaGuards.push(newIdx);
        }
        normalizePandaGuards();
        trace('🐼 扣除110HP，生成 70HP 金刚罩${kingShields.length}。当前HP ${hp}');
        return "金刚罩生成成功";
    }

    public function setPandaMode(mode:String):String {
        if (mode != "heal" && mode != "shield") return "错误：未知模态";
        pandaMode = mode;
        trace('🐼 切换模态：${mode == "heal" ? "回血流" : "回盾流"}');
        return "模态切换成功";
    }

    public function setPandaGuardExclusive(guard:Int):String {
        cleanKingShields();
        if (guard != -1 && (guard < 0 || guard >= kingShields.length)) return "错误：金刚罩不存在";
        pandaGuards = [guard];
        normalizePandaGuards();
        return guard == -1 ? "已设置仅本体抗伤" : '已设置仅金刚罩${guard + 1}抗伤';
    }

    public function togglePandaGuard(guard:Int):String {
        cleanKingShields();
        if (guard != -1 && (guard < 0 || guard >= kingShields.length)) return "错误：金刚罩不存在";
        var pos = pandaGuards.indexOf(guard);
        if (pos >= 0) {
            pandaGuards.splice(pos, 1);
            normalizePandaGuards();
            return guard == -1 ? "已取消本体抗伤" : '已取消金刚罩${guard + 1}抗伤';
        }
        if (pandaGuards.length >= 4) return "错误：最多选择4个抗伤单位";
        pandaGuards.push(guard);
        normalizePandaGuards();
        return guard == -1 ? "已加入本体抗伤" : '已加入金刚罩${guard + 1}抗伤';
    }

    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        if (actionName == "pandaMakeShield") return makeKingShield();
        if (actionName == "pandaSetMode") return setPandaMode(Std.string(params.mode));
        if (actionName == "pandaSetGuard") return setPandaGuardExclusive(params.guard); // 兼容旧AI/旧按钮
        if (actionName == "pandaToggleGuard") return togglePandaGuard(params.guard);
        return super.handleAction(actionName, params, engine);
    }

    override public function getCustomDisplay():String {
        cleanKingShields();
        var modeName = pandaMode == "heal" ? "回血流" : "回盾流";
        var parts:Array<String> = [];
        for (i in 0...kingShields.length) {
            var mark = pandaGuards.indexOf(i) >= 0 ? "★" : "";
            parts.push('${mark}罩${i + 1}:${kingShields[i]}');
        }
        if (parts.length == 0) parts.push("无罩");
        var guardParts:Array<String> = [];
        for (g in pandaGuards) guardParts.push(g == -1 ? "本体" : '罩${g + 1}');
        return '🐼 <b>${modeName}</b> | 抗伤:<b>${guardParts.join("+")}</b> | 金刚罩: ${parts.join(" ")}';
    }

    override public function getCustomActions():Array<CustomAction> {
        cleanKingShields();
        var actions:Array<CustomAction> = [];
        actions.push({ label: pandaMode == "heal" ? "切回盾流" : "切回血流", color: "#722ed1", enabled: true,
            onClickJS: pandaMode == "heal" ? 'invokeAction2(__IDX__, "pandaSetMode", {mode:"shield"})' : 'invokeAction2(__IDX__, "pandaSetMode", {mode:"heal"})' });
        actions.push({ label: '扣110造罩(${kingShields.length}/7)', color: "#fa8c16", enabled: hp > 110 && kingShields.length < 7,
            onClickJS: 'invokeAction2(__IDX__, "pandaMakeShield", {})' });
        actions.push({ label: (pandaGuards.indexOf(-1) >= 0 ? "✓ " : "") + "本体抗伤", color: pandaGuards.indexOf(-1) >= 0 ? "#1890ff" : "#ffffff", enabled: true,
            onClickJS: 'invokeAction2(__IDX__, "pandaToggleGuard", {guard:-1})' });
        for (i in 0...kingShields.length) {
            var selected = pandaGuards.indexOf(i) >= 0;
            actions.push({ label: (selected ? "✓ " : "") + '罩${i + 1}抗伤', color: selected ? "#1890ff" : "#ffffff", enabled: true,
                onClickJS: 'invokeAction2(__IDX__, "pandaToggleGuard", {guard:${i}})' });
        }
        return actions;
    }

    override public function getSnapshotExtras():Array<String> {
        cleanKingShields();
        var guardParts:Array<String> = [];
        for (g in pandaGuards) guardParts.push(g == -1 ? "本体" : "罩" + (g + 1));
        return ['🐼${pandaMode == "heal" ? "回血流" : "回盾流"} 金刚罩:${kingShields.join("/")} 抗伤:${guardParts.join("+")}'];
    }
}
