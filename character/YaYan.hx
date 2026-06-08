package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import buffs.CrowBuff;

/**
 * 鸦眼（输出 | HP: 140）
 *
 * 技能1 - 乌鸦诅咒：主动，自扣40血，弹窗选阵营，对目标阵营所有人施加乌鸦buff（2回合，不叠加）
 *   乌鸦buff：物理/真实基础+20，法/毒+10（在攻击者乘算之前加算）
 *   触发后：鸦眼RECOVERY回血 = 乘算后的额外增量；获得触发次数只乌鸦
 *
 * 技能2 - 灼燃箭：攻击时toggle开启
 *   攻击时让目标身上乌鸦buff的 extraTriggers+2（加算额外×2次）
 *   攻击后额外法伤 = |鸦眼双手和 - 受击者双手和| × 10；鸦眼SUPPLY补给等量
 *   攻击后鸦眼自扣60物理
 *
 * 技能3 - 魔王剑：消耗6乌鸦，需灼燃箭开启
 *   灼燃箭 extraTriggers 再+2（共+4），法伤和回血×2
 *   行动结束扣150物理
 */
class YaYan extends Player {

    @:keep public var crowCount:Int = 0;
    @:keep public var useBurningArrow:Bool = false;
    @:keep public var useDemonSword:Bool = false;
    private var _inSkillEffect:Bool = false;

    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 140, camp);
    }

    // ── 攻击后：灼燃箭法伤 + 自扣 ──
    override public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {
        if (_inSkillEffect || type != PHYSICAL) return;

        if (useBurningArrow) {
            var mySum = this.hands[0] + this.hands[1];
            var targetSum = target.hands[0] + target.hands[1];
            var baseMagic = Std.int(Math.abs(mySum - targetSum)) * 10;
            var magicDmg = useDemonSword ? baseMagic * 2 : baseMagic;

            if (magicDmg > 0) {
                trace('🦅 灼燃箭法伤：|${mySum}-${targetSum}|×10${useDemonSword?" ×2":""}=${magicDmg}');
                _inSkillEffect = true;
                engine.applyRawDamage(this, target, magicDmg, MAGIC);
                _inSkillEffect = false;
                engine.applyRawHeal(this, magicDmg, SUPPLY, true);
                trace('🦅 灼燃箭补给鸦眼：+${magicDmg}血');
            }

            trace('🦅 灼燃箭自耗：-60 物理');
            _inSkillEffect = true;
            this.handleIncomingDamage(null, 60, PHYSICAL);
            _inSkillEffect = false;
        }
    }

    // ── 行动结束：魔王剑扣血，重置技能状态 ──
    override public function onTurnEnd():Void {
        super.onTurnEnd();
        if (useDemonSword) {
            trace('🦅 魔王剑代价：-150 物理');
            this.handleIncomingDamage(null, 150, PHYSICAL);
        }
        useBurningArrow = false;
        useDemonSword = false;
    }

    // ── UI 显示 ──
    override public function getCustomDisplay():String {
        var s = '🦅 乌鸦：${crowCount} 只';
        if (useBurningArrow) s += ' | 🔥灼燃';
        if (useDemonSword) s += ' | ⚔️魔王';
        return s;
    }

    override public function getCustomActions():Array<CustomAction> {
        return [
            {
                label: '🐦 乌鸦诅咒（-40血）',
                color: '#722ed1',
                enabled: this.hp > 40,
                onClickJS: "showCrowCurseDialog(__IDX__); render2();"
            },
            {
                label: (useBurningArrow ? '✓ ' : '') + '灼燃箭（-60）',
                color: useBurningArrow ? '#cf1322' : '#595959',
                enabled: true,
                onClickJS: "Main.invokeAction(__IDX__, 'toggleBurningArrow', {}); render2();"
            },
            {
                label: (useDemonSword ? '✓ ' : '') + '魔王剑（6🦅）',
                color: useDemonSword ? '#d4380d' : '#595959',
                enabled: crowCount >= 6 && useBurningArrow,
                onClickJS: "Main.invokeAction(__IDX__, 'toggleDemonSword', {}); render2();"
            }
        ];
    }

    override public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        switch (actionName) {

            case 'crowCurseTarget':
                // params.camp: 'enemy' | 'ally'（含自身）
                if (this.hp <= 40) return '错误：HP不足（需>40血）';
                var targetCamp:String = (params != null && params.camp != null) ? params.camp : 'enemy';
                this.hp -= 40;
                trace('🦅 鸦眼释放乌鸦诅咒！自扣40血（剩${this.hp}），目标：${targetCamp}');
                if (engine.turnManager != null) {
                    for (p in engine.turnManager.players) {
                        if (p.hp <= 0) continue;
                        var isEnemy = (p.camp != this.camp);
                        var isAlly  = (p.camp == this.camp);
                        var include = (targetCamp == 'enemy') ? isEnemy : isAlly;
                        if (!include) continue;
                        // 移除旧buff（不叠加）
                        var old:buffs.CrowBuff = null;
                        for (b in p.buffList) if (Std.isOfType(b, buffs.CrowBuff)) { old = cast b; break; }
                        if (old != null) p.buffList.remove(old);
                        // 施加新buff
                        p.addBuff(new CrowBuff(2, this));
                        trace('🦅 乌鸦诅咒 → ${p.name}（2回合）');
                    }
                }
                return 'ok';

            case 'toggleBurningArrow':
                useBurningArrow = !useBurningArrow;
                if (!useBurningArrow) useDemonSword = false;
                trace('🦅 灼燃箭：${useBurningArrow ? "开启" : "关闭"}');
                return 'ok';

            case 'toggleDemonSword':
                if (!useBurningArrow) return '错误：需先开启灼燃箭';
                if (crowCount < 6) return '错误：乌鸦不足（当前${crowCount}）';
                if (!useDemonSword) {
                    useDemonSword = true;
                    crowCount -= 6;
                    trace('🦅 魔王剑激活！消耗6只乌鸦（剩${crowCount}）');
                } else {
                    useDemonSword = false;
                    crowCount += 6;
                    trace('🦅 魔王剑取消，退还6只乌鸦（剩${crowCount}）');
                }
                return 'ok';

            case 'injectCrowTriggers':
                // JS层在攻击前调用：把extraTriggers注入到dmgTarget身上的CrowBuff
                var tIdx:Int = (params != null && params.targetIdx != null) ? Std.int(params.targetIdx) : -1;
                if (engine.turnManager == null || tIdx < 0) return 'ok';
                var tp = engine.turnManager.players[tIdx];
                var extra = (useBurningArrow ? 1 : 0) + (useDemonSword ? 2 : 0); // 灼燃: triggers=2，魔王再+2: triggers=4
                for (b in tp.buffList) {
                    if (Std.isOfType(b, buffs.CrowBuff)) {
                        cast(b, buffs.CrowBuff).extraTriggers = extra;
                        trace('🦅 注入乌鸦触发+${extra}到${tp.name}');
                        break;
                    }
                }
                return 'ok';
        }
        return super.handleAction(actionName, params, engine);
    }

    @:keep override public function interceptAttackForDialog(myHand:Int, touchTarget:Player, touchHandIdx:Int):Bool {
        return false;
    }
    @:keep override public function canReceiveHelpTank():Bool { return true; }
}
