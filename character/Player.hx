package model;

class Player {
    public var id:String;
    public var name:String;
    public var hp:Int;
    public var hands:Array<Int> = [1, 1];
    public var camp:Camp;
    
    public var zeroTurns0:Int = 0;
    public var zeroTurns1:Int = 0;
    public var initTurns:Int = 2; 
    public var forcedZeroHand:Int = -1;
    public var pendingHealing:Int = 0;

    public var shieldList:Array<ShieldInstance> = new Array<ShieldInstance>();
    public var buffList:Array<Buff> = new Array<Buff>();

    public function new(id:String, name:String, hp:Int, camp:Camp) {
        this.id = id;
        this.name = name;
        this.hp = hp;
        this.camp = camp;
    }

    // ─────────────────────────────────────────────────────────────
    // 【钩子接口】供英雄子类重写
    // ─────────────────────────────────────────────────────────────

    /**
     * 出伤倍率（子类重写：比如小乔物伤*1.5）
     * 返回经过本角色加成后的伤害值
     */
    public function calculateOutputDamage(baseAmount:Int, type:DamageType):Int {
        return baseAmount;
    }

    /**
     * 回血倍率（子类重写：比如小乔回血*1.5）
     */
    public function calculateFinalHeal(baseAmount:Int, type:HealType):Int {
        return baseAmount;
    }

    /**
     * 钩子：成功造成伤害后触发（用于小乔"打人补给等量血"等技能）
     * @param target 被打的对象
     * @param damageBeforeShield 减伤后、但还没被护盾扣除前的伤害值（小乔补给用的就是这个）
     * @param actualDamage 实际扣血额（穿透护盾后的）
     * @param type 伤害类型
     * @param engine 用于子类调用 applyRawHeal 防套娃
     */
    public function onAfterDealtDamage(target:Player, damageBeforeShield:Int, actualDamage:Int, type:DamageType, engine:GameEngine):Void {}

    /**
     * 钩子：成功回血后触发（用于小乔"回血时对敌方造成等量伤害"等技能）
     */
    public function onAfterHeal(actualHeal:Int, type:HealType, engine:GameEngine):Void {}

    // ─────────────────────────────────────────────────────────────
    // 【全场事件监听钩子】（藏师草莓蛋糕等需要监听全场行为的技能）
    // ─────────────────────────────────────────────────────────────

    /**
     * 监听：场上任何玩家发生回血事件
     * @param healer 回血对象
     * @param amount 实际回血量
     * @param type   回血类型
     * @param isFromSkill 是否来自技能内部（如藏师补给自己时，本次回血不应再触发蛋糕）
     */
    public function onAnyHealHappened(healer:Player, amount:Int, type:HealType, isFromSkill:Bool, engine:GameEngine):Void {}

    /**
     * 监听：场上任何玩家获取护盾
     */
    public function onAnyShieldGained(target:Player, isFromSkill:Bool, engine:GameEngine):Void {}

    /**
     * 监听：场上任何玩家"输出"了一次伤害（攻击者侧加成完毕，但还未进入target侧减伤/护盾）
     * 用于孙悟空根据全场输出值更新 x
     * @param attacker 攻击者
     * @param target 被打者
     * @param outputDamage 攻击者侧最终输出值（calculateOutputDamage + 攻击者所有onDealDamage Buff后）
     * @param type 伤害类型
     */
    public function onAnyOutputDamage(attacker:Player, target:Player, outputDamage:Int, type:DamageType, engine:GameEngine):Void {}

    /**
     * 监听：场上任何玩家因毒伤扣血（含护盾后的实际扣血量）
     * 用于忍者"中毒扣血时回血"被动
     */
    public function onAnyPoisonTick(victim:Player, actualPoisonDamage:Int, engine:GameEngine):Void {}

    /**
     * 监听：场上任何玩家解了一层毒（回血解毒时触发）
     * 用于忍者"解毒时回20"被动
     */
    public function onAnyPoisonCleared(victim:Player, engine:GameEngine):Void {}

    /**
     * 监听：场上某玩家因雷霆之怒扣血
     * @param caster 雷霆之怒的施加者（法师）
     * @param victim 被扣血的对象
     * @param actualDamage 实际扣血量
     */
    public function onAnyThunderTick(caster:Player, victim:Player, actualDamage:Int, engine:GameEngine):Void {}

    /**
     * 监听：大回合结束（所有玩家都行动完一轮）
     * 用于藏师的每大回合8次计数重置
     */
    /**
     * 监听：场上某玩家开始新的行动回合（TurnManager 找到下一个行动者后广播）
     * 用于大乔每人每轮只能抢一次冷却重置
     */
    public function onAnyTurnStart(actor:Player, engine:GameEngine):Void {}

    public function onBigRoundEnd():Void {}

    // ─────────────────────────────────────────────────────────────
    // 【角色自描述接口】让角色自己描述前端显示、日志快照、按钮、技能覆盖
    // 新增角色无需修改 Main.hx / GameEngine.hx
    // ─────────────────────────────────────────────────────────────

    /**
     * 返回角色卡片下方要显示的特殊状态HTML（如藏师蛋糕、孙悟空xy）
     * 默认返回空 = 不显示
     */
    public function getCustomDisplay():String return "";

    /**
     * 返回角色卡片下方要显示的自定义按钮列表（如藏师"使用蛋糕"按钮）
     * 默认空数组
     */
    public function getCustomActions():Array<CustomAction> return [];

    /**
     * 返回角色在快照日志里附加的特殊状态字段
     */
    public function getSnapshotExtras():Array<String> return [];

    /**
     * 角色尝试覆盖默认的组合技能效果
     * @param comboKey 组合标识，如 "0_2"、"0_6"、"double_9"
     * @return true = 角色已自行处理；false = 走默认
     */
    public function tryOverrideComboEffect(comboKey:String, target:Player, engine:GameEngine):Bool return false;

    /**
     * 钩子：TurnManager 在每次 zeroTurns 递减前询问角色是否要跳过本次递减
     * 孙悟空在 [0,2] 触发后返回 true（下回合跳过递减，不消耗0使用次数）
     */
    public function shouldSkipZeroTurnsDecrement():Bool return false;

    /**
     * 钩子：每次碰手结算完后调用，角色可在此重置零组合相关状态
     * 孙悟空重写：当双手都不是0时，重置 [0,2] 使用计数
     */
    public function onAfterTouchResolved():Void {}

    /**
     * 钩子：进入 triggerZeroCombo 前调用，角色可在此设置"零组合上下文"标记
     * 法师重写：设置 _inZeroCombo = true，让 calculateOutputDamage 知道要翻倍
     */
    public function onEnterZeroComboContext():Void {}

    /**
     * 钩子：退出 triggerZeroCombo 后调用，角色清理上下文标记
     */
    public function onExitZeroComboContext():Void {}

    /**
     * 通用前端调用入口：所有角色主动技能/操作都通过这个钩子分发
     * 子类重写它来处理自己的特殊action（如蛋糕、进化、抢夺）
     * @param actionName 动作名（如 "useCake"、"evolve"、"doSteal"）
     * @param params    动作参数（Dynamic对象，由前端传JS对象过来）
     * @param engine    引擎
     * @return 结果字符串（前端可用于弹错误提示）
     */
    public function handleAction(actionName:String, params:Dynamic, engine:GameEngine):String {
        return "错误：当前角色不支持动作 " + actionName;
    }

    /**
     * 钩子：HP<=0 时 TurnManager 询问角色是否要触发"复活/假死"机制
     * 返回 true = 成功救活（角色已自行调整HP，TurnManager 不再判死）
     * 返回 false = 真的死了
     * 用于：大乔复活甲、其他不死类技能
     */
    public function tryRevive(engine:GameEngine):Bool return false;

    // ─────────────────────────────────────────────────────────────
    // Buff 管理
    // ─────────────────────────────────────────────────────────────
    public function addBuff(newBuff:Buff) {
        for (b in buffList) {
            if (b.id == newBuff.id) {
                b.layers += newBuff.layers;
                return;
            }
        }
        buffList.push(newBuff);
    }

    public function getBuff(buffId:String):Buff {
        for (b in buffList) {
            if (b.id == buffId) return b;
        }
        return null;
    }

    public function onTurnEnd() {
        for (b in buffList) {
            b.onTurnEnd(this);
        }
        cleanEmptyBuffs();
        decreaseShieldDuration();
    }

    // ─────────────────────────────────────────────────────────────
    // 护盾
    // ─────────────────────────────────────────────────────────────
    public function addShield(type:ShieldType, amount:Int, duration:Int) {
        var merged = false;
        for (shield in shieldList) {
            if (shield.type == type && shield.duration == duration) {
                shield.amount += amount;
                merged = true;
                break;
            }
        }
        if (!merged) {
            shieldList.push(new ShieldInstance(type, amount, duration));
        }
    }

    /**
     * 【完整版核心抗伤逻辑】
     * 返回值：[减伤后伤害值, 实际扣血额]
     * - 减伤后伤害值：经过 Buff、减免后的"理论伤害"（包括被护盾挡住的部分）
     * - 实际扣血额：扣到血条上的部分
     * 
     * 调用者：通常是 GameEngine.applyDamage / applyRawDamage
     */
    public function handleIncomingDamage(attacker:Player, amount:Int, dmgType:DamageType):DamageResult {
        if (amount <= 0) return { damageBeforeShield: 0, actualDamage: 0 };
        var finalDamage = amount;

        // 0. 攻击者的 Buff 修改伤害（如双4翻倍）
        // 注意：这里的伤害已经是 calculateOutputDamage 之后的了，所以这里仅做Buff加成
        if (attacker != null) {
            for (b in attacker.buffList) {
                finalDamage = b.onDealDamage(attacker, this, finalDamage, dmgType);
            }
            attacker.cleanEmptyBuffs();
        }

        // 1. 自己的 Buff 拦截（如双5反弹、双1无敌）
        for (b in buffList) {
            finalDamage = b.onTakeDamage(this, attacker, finalDamage, dmgType);
        }
        if (finalDamage <= 0) {
            cleanEmptyBuffs();
            return { damageBeforeShield: 0, actualDamage: 0 };
        }

        // 【关键】记录"减伤后但未被护盾抵挡前"的伤害值
        var damageBeforeShield = finalDamage;

        // 2. 护盾抗伤
        while (finalDamage > 0) {
            var validShields = [];
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
                if (canBlock) validShields.push(shield);
            }
            if (validShields.length == 0) break;
            validShields.sort(function(a, b) { return a.duration - b.duration; });
            var bestShield = validShields[0];
            if (bestShield.amount >= finalDamage) {
                bestShield.amount -= finalDamage;
                finalDamage = 0;
            } else {
                finalDamage -= bestShield.amount;
                bestShield.amount = 0;
            }
            cleanEmptyShields();
        }

        // 3. 落地扣血
        this.hp -= finalDamage;
        return { damageBeforeShield: damageBeforeShield, actualDamage: finalDamage };
    }

    // 在 model/Player.hx 中添加
/**
 * 触碰行为的合法性通用预检
 * @param handIdx 当前玩家准备动用的手索引（0左 1右）
 * @param target 目标玩家
 * @param targetHandIdx 目标玩家的手索引
 * @return 是否允许这次触碰交互
 */
    // 请粘贴到 model/Player.hx 中
/**
 * 触碰行为的合法性通用预检（基类默认逻辑）
 * @return 是否允许这次触碰交互
 */
    public function isValidTouch(handIdx:Int, target:Player, targetHandIdx:Int):Bool {
        var otherIdx = 1 - handIdx;
        // 基类默认规则：如果另一只手是 0 且寿命扣光了，而你本回合又没动它，说明它下回合必死，因此该交互非法
        if (this.hands[otherIdx] == 0) {
            var otherTurns = (otherIdx == 0) ? this.zeroTurns0 : this.zeroTurns1;
            if (otherTurns <= 0) {
                return false;
            }
        }
        return true;
    }

    private function cleanEmptyShields() {
        var i = shieldList.length - 1;
        while (i >= 0) {
            if (shieldList[i].amount <= 0) shieldList.splice(i, 1);
            i--;
        }
    }
    

    public function cleanEmptyBuffs() {
        var i = buffList.length - 1;
        while (i >= 0) {
            if (buffList[i].layers <= 0) buffList.splice(i, 1);
            i--;
        }
    }

    public function decreaseShieldDuration() {
        var i = shieldList.length - 1;
        while (i >= 0) {
            var shield = shieldList[i];
            shield.duration--;
            if (shield.duration <= 0) shieldList.splice(i, 1); 
            i--;
        }
    }
}

/**
 * 用于返回伤害结算的两种数值
 */
typedef DamageResult = {
    var damageBeforeShield:Int; // 减伤后但还未被护盾抵挡前的伤害
    var actualDamage:Int;        // 实际扣血额
}

/**
 * 角色自定义按钮（藏师"使用蛋糕"等）
 * playerIdx 由前端在渲染时传入；callbackName 是要触发的 Main 静态方法名
 */
typedef CustomAction = {
    var label:String;       // 按钮文字
    var color:String;       // 按钮背景色
    var enabled:Bool;       // 是否可点击
    var onClickJS:String;   // 点击时执行的JS片段（含 Main.xxx(playerIdx) 等）
}
