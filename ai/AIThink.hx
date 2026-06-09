package ai;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import GameEngine;
import TurnManager;
import model.Buff;
import character.CharacterRegistry;

/**
 * AI 思考模块 - 启发式评估 + 可进化权重
 *
 * 设计要点：
 * - AIThink 可以**实例化**，每个实例有独立权重（用于进化对比）
 * - 保留静态 `default` 实例作为默认 AI
 * - 权重通过 WeightSet 结构体管理，方便序列化和对比
 * - 评估函数完全基于结构化数据，不依赖文字日志解析
 */
class AIThink {

    // ─────────────────────────────────────────────────────────────
    // 默认权重常量（作为基准参考）
    // ─────────────────────────────────────────────────────────────
    public static var DEFAULT_WEIGHTS:WeightSet = {
        damage:       3.0,
        heal:         2.0,
        shield:       1.5,
        poison:       1.2,
        doubleStar:  50.0,
        zeroCombo:   25.0,
        sixCombo:    15.0,
        zeroRisk:    0.0,  // 0 没有风险，双手全0只是强制用0手，不会死亡
        zeroCountdown: 0.0, // 倒计时快用完不是坏事，0组合收益极高
        oppZeroGood: 20.0,
        hpAdvantage:  0.5,
        handQuality:  2.0,
        // 角色特化权重
        mageZeroBonus:    15.0,  // 法师0组合加成
        wukongZeroTwoBonus: 30.0, // 悟空[0,2]加成
        ninjaAttackBonus:  8.0,  // 忍者持续攻击加成（触发毒+法伤被动）
        zhangfeiHealBonus: 10.0, // 张飞[0,4/6]回血加成（积累怒气）
        xiaoqiaoHealBonus: 15.0, // 小乔回血加成（回血×1.5）
        zangshiCakeThreshold: 6.0, // 藏师蛋糕数量达到此值时开始使用
        // 张飞模态偏好（0=无偏好，正值=偏好该模态）
        zhangfeiModal1Pref: 5.0,
        zhangfeiModal3Pref: 3.0,
    };

    // ─────────────────────────────────────────────────────────────
    // 实例权重（默认复制 DEFAULT_WEIGHTS）
    // ─────────────────────────────────────────────────────────────
    public var weights:WeightSet;

    // Elo 评分（用于进化排名）
    public var elo:Float = 1200.0;

    // 标识符（用于日志）
    public var id:String;

    public function new(?id:String, ?weights:WeightSet) {
        this.id = (id != null) ? id : "AI_" + Std.string(Std.random(9999));
        this.weights = (weights != null) ? weights : copyWeights(DEFAULT_WEIGHTS);
    }

    // ─────────────────────────────────────────────────────────────
    // 权重工具方法
    // ─────────────────────────────────────────────────────────────

    public static function copyWeights(w:WeightSet):WeightSet {
        return {
            damage: w.damage, heal: w.heal, shield: w.shield, poison: w.poison,
            doubleStar: w.doubleStar, zeroCombo: w.zeroCombo, sixCombo: w.sixCombo,
            zeroRisk: w.zeroRisk, zeroCountdown: w.zeroCountdown, oppZeroGood: w.oppZeroGood,
            hpAdvantage: w.hpAdvantage, handQuality: w.handQuality,
            mageZeroBonus: w.mageZeroBonus, wukongZeroTwoBonus: w.wukongZeroTwoBonus,
            ninjaAttackBonus: w.ninjaAttackBonus, zhangfeiHealBonus: w.zhangfeiHealBonus,
            xiaoqiaoHealBonus: w.xiaoqiaoHealBonus, zangshiCakeThreshold: w.zangshiCakeThreshold,
            zhangfeiModal1Pref: w.zhangfeiModal1Pref, zhangfeiModal3Pref: w.zhangfeiModal3Pref,
        };
    }

    /**
     * 对权重施加随机扰动，生成"挑战者"权重
     * @param magnitude 扰动幅度（0.1 = 10%随机变动）
     */
    public static function mutateWeights(base:WeightSet, magnitude:Float = 0.15):WeightSet {
        function perturb(v:Float):Float {
            var noise = (Math.random() * 2 - 1) * magnitude;
            // 保持符号（负权重不能变正）
            var result = v * (1.0 + noise);
            if (v < 0 && result > 0) return v * 0.5;
            if (v > 0 && result < 0) return v * 0.5;
            return result;
        }
        return {
            damage: perturb(base.damage), heal: perturb(base.heal),
            shield: perturb(base.shield), poison: perturb(base.poison),
            doubleStar: perturb(base.doubleStar), zeroCombo: perturb(base.zeroCombo),
            sixCombo: perturb(base.sixCombo), zeroRisk: perturb(base.zeroRisk),
            zeroCountdown: perturb(base.zeroCountdown), oppZeroGood: perturb(base.oppZeroGood),
            hpAdvantage: perturb(base.hpAdvantage), handQuality: perturb(base.handQuality),
            mageZeroBonus: perturb(base.mageZeroBonus),
            wukongZeroTwoBonus: perturb(base.wukongZeroTwoBonus),
            ninjaAttackBonus: perturb(base.ninjaAttackBonus),
            zhangfeiHealBonus: perturb(base.zhangfeiHealBonus),
            xiaoqiaoHealBonus: perturb(base.xiaoqiaoHealBonus),
            zangshiCakeThreshold: Math.max(3, perturb(base.zangshiCakeThreshold)),
            zhangfeiModal1Pref: perturb(base.zhangfeiModal1Pref),
            zhangfeiModal3Pref: perturb(base.zhangfeiModal3Pref),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // 兼容旧静态接口（供 BattleLearning 和外部调用）
    // ─────────────────────────────────────────────────────────────
    static var _defaultInstance:AIThink = new AIThink("default");

    public static function getWeight(name:String):Float {
        return getWeightFrom(_defaultInstance.weights, name);
    }

    public static function setWeight(name:String, value:Float):Void {
        setWeightOn(_defaultInstance.weights, name, value);
    }

    public static function getAllWeights():Map<String, Float> {
        return weightsToMap(_defaultInstance.weights);
    }

    // ─────────────────────────────────────────────────────────────
    // 核心：选择最佳行动（实例方法）
    // ─────────────────────────────────────────────────────────────

    public function chooseActionWith(actor:Player, opponent:Player, engine:GameEngine):{myHand:Int, targetHand:Int} {
        var candidates:Array<CandidateMove> = [];

        for (myHandIdx in 0...2) {
            for (targetHandIdx in 0...2) {
                if (opponent.hands[targetHandIdx] == 0) continue;
                if (!actor.isValidTouch(myHandIdx, opponent, targetHandIdx)) continue;

                var score = evaluateMoveWith(actor, opponent, myHandIdx, targetHandIdx, engine);
                candidates.push({ myHandIdx: myHandIdx, targetHandIdx: targetHandIdx, score: score });
            }
        }

        if (candidates.length == 0) return null;
        candidates.sort(function(a, b) return Std.int(b.score - a.score));

        // Top-3 随机选（避免过于机械）
        var topCount = Std.int(Math.min(3, candidates.length));
        var chosen = candidates[Std.random(topCount)];

        trace('🧠 [${id}] ${actor.name} 选择：手${chosen.myHandIdx}→对手手${chosen.targetHandIdx}，分数${Std.int(chosen.score)}');
        return { myHand: chosen.myHandIdx, targetHand: chosen.targetHandIdx };
    }

    public function evaluateMoveWith(actor:Player, opponent:Player, myHandIdx:Int, targetHandIdx:Int, engine:GameEngine):Float {
        var w = this.weights;
        var score:Float = 0;
        var oldValue = actor.hands[myHandIdx];
        var newValue = (oldValue + opponent.hands[targetHandIdx]) % 10;

        score += estimateImmediateBenefit(actor, opponent, myHandIdx, oldValue, newValue, w);
        score += evaluateComboPotential(actor, newValue, myHandIdx, w);
        score += evaluateRisk(actor, myHandIdx, newValue, w);
        score += evaluateOpponentThreat(actor, opponent, w);
        score += evaluateCharacterSpecific(actor, opponent, myHandIdx, newValue, w, engine);

        return score;
    }

    // ─────────────────────────────────────────────────────────────
    // 静态快捷接口（给 AIBattleRunner 的简单调用）
    // ─────────────────────────────────────────────────────────────
    public static function chooseAction(actor:Player, opponent:Player, engine:GameEngine):{myHand:Int, targetHand:Int} {
        return _defaultInstance.chooseActionWith(actor, opponent, engine);
    }

    /**
     * MCTS-based action selection.
     * @param useMCTS if false, falls back to original top-3 random
     */
    public function chooseActionWithMCTS(
        actor:Player, opponent:Player, engine:GameEngine,
        useMCTS:Bool = true
    ):{myHand:Int, targetHand:Int} {
        if (!useMCTS) return chooseActionWith(actor, opponent, engine);

        var actorIdx = engine.turnManager.currentPlayerIdx;
        var state = StateCopier.snapshot(engine, actorIdx);
        var search = new MCTSSearch(state, this);
        var action = search.run();
        trace('🧠 [MCTS] ${actor.name} chose hand${action.myHand}→opp${action.targetHand}');
        return { myHand: action.myHand, targetHand: action.targetHand };
    }

    // ─────────────────────────────────────────────────────────────
    // 评估函数（接受权重参数，无副作用，易于测试）
    // ─────────────────────────────────────────────────────────────

    private static function estimateImmediateBenefit(actor:Player, opponent:Player, handIdx:Int, oldValue:Int, newValue:Int, w:WeightSet):Float {
        var score:Float = 0;
        var simHands = actor.hands.copy();
        simHands[handIdx] = newValue;

        // [x,6] 触发 → 回血30
        if (newValue == 6 && oldValue != 6) {
            score += 30 * w.heal;
        }

        // 0组合收益估算
        if (simHands[0] == 0 || simHands[1] == 0) {
            var otherVal = (simHands[0] == 0) ? simHands[1] : simHands[0];
            score += evaluateZeroComboValue(otherVal, w);
        }

        // 双子星收益
        if (simHands[0] == simHands[1]) {
            score += estimateDoubleStarValue(simHands[0], w);
        }

        return score;
    }

    private static function evaluateZeroComboValue(otherValue:Int, w:WeightSet):Float {
        switch (otherValue) {
            case 0:    return 150 * w.damage;
            case 1,5,8,9: return 40 * w.damage;
            case 2,3:  return 20 * w.shield;
            case 4,6:  return 30 * w.heal;
            case 7:    return 10 * w.damage + 10 * w.poison;
        }
        return 0;
    }

    private static function estimateDoubleStarValue(num:Int, w:WeightSet):Float {
        // 双子星各有不同价值，做粗略估算
        switch (num) {
            case 9: return 200 * w.damage; // [9,9] 超级伤害
            case 0: return 150 * w.damage; // [0,0] 真伤
            case 7: return 30 * w.damage + 30 * w.poison;
            case 6: return 90 * w.heal;
            case 8: return 60 * w.damage;  // 额外行动
            case 1: return 50;             // 无敌（防御价值难量化）
            case 4: return 40 * w.damage;  // 翻倍
            case 5: return 30;             // 反弹
            case 2,3: return 30 * w.shield;
        }
        return w.doubleStar;
    }

    private static function evaluateComboPotential(actor:Player, newValue:Int, handIdx:Int, w:WeightSet):Float {
        var score:Float = 0;
        var otherValue = actor.hands[1 - handIdx];

        // 双子星潜力
        if (newValue == otherValue) score += w.doubleStar;
        else if (newValue != 0 && (Math.abs(newValue - otherValue) == 1 || Math.abs(newValue - otherValue) == 9)) {
            score += 10; // 差1就能凑
        }

        // 0组合潜力
        if (newValue == 0) score += w.zeroCombo;

        // [x,6] 潜力
        if (otherValue == 6 || newValue == 6) score += w.sixCombo;

        return score;
    }

    private static function evaluateRisk(actor:Player, handIdx:Int, newValue:Int, w:WeightSet):Float {
        var score:Float = 0;
        // 0 没有额外风险——倒计时只是强制下次用0手行动，0组合收益极高
        // （原"双0死亡"逻辑已删除，规则中双手全0不会死亡）
        return score;
    }

    private static function evaluateOpponentThreat(actor:Player, opponent:Player, w:WeightSet):Float {
        var score:Float = 0;

        if (opponent.hands[0] == 0 && opponent.hands[1] == 0) score += 30;
        if (opponent.hands[0] == 0 && opponent.zeroTurns0 <= 1) score += w.oppZeroGood * 0.5;
        if (opponent.hands[1] == 0 && opponent.zeroTurns1 <= 1) score += w.oppZeroGood * 0.5;

        var hpDiff = actor.hp - opponent.hp;
        score += hpDiff * w.hpAdvantage;

        return score;
    }

    private static function evaluateCharacterSpecific(
        actor:Player, opponent:Player, myHandIdx:Int, newValue:Int,
        w:WeightSet, engine:GameEngine
    ):Float {
        var score:Float = 0;
        var name = actor.name;
        var otherIdx = 1 - myHandIdx;
        var otherVal = actor.hands[otherIdx];

        // ── 法师：0组合有翻倍+45法伤额外加成 ──
        if (name == "法师" || name == "fashi") {
            if (newValue == 0) score += w.mageZeroBonus;
        }

        // ── 孙悟空：[0,2]大招价值高 ──
        if (name == "孙悟空" || name == "sunwukong") {
            if ((newValue == 0 && otherVal == 2) || (newValue == 2 && otherVal == 0)) {
                score += w.wukongZeroTwoBonus; // 70法伤+回70+冻结
            }
            // 孙悟空打物伤会叠加x值，优先打人
            if (newValue != 0 && newValue != 2) score += 5;
        }

        // ── 忍者：打物伤就附加50%法伤+加毒，核心收益来自持续攻击 ──
        if (name == "忍者" || name == "renzhe") {
            // 只要打物伤就加分（不管打出多少），因为被动技能已经算好了
            if (newValue != 0) {
                // 检查敌方毒层越多忍者减伤越高，此时更安全，可以激进
                var poisonBuff = opponent.getBuff("POISON");
                var poisonLayers = (poisonBuff != null) ? poisonBuff.layers : 0;
                score += w.ninjaAttackBonus + poisonLayers * 3.0;
            }
        }

        // ── 张飞：模态③和[0,4/6]回血能积累怒气 ──
        if (name == "张飞" || name == "zhangfei") {
            if (newValue == 4 || newValue == 6) score += w.zhangfeiHealBonus;
            // 检查是否接近狂暴（24怒气）
            var zf = Std.isOfType(actor, character.ZhangFei) ? (cast actor : character.ZhangFei) : null;
            if (zf != null) {
                if (zf.rage >= 20) score += 20; // 接近狂暴时激进
                if (zf.frenzyTurns > 0) score += 15; // 狂暴中优先打伤害
                // 模态偏好
                if (zf.modal == 1) score += w.zhangfeiModal1Pref;
                if (zf.modal == 3 && newValue != 0) score += w.zhangfeiModal3Pref;
            }
        }

        // ── 小乔：[x,6]和[0,4]回血×1.5有额外价值 ──
        if (name == "小乔" || name == "xiaoqiao") {
            if (newValue == 6) score += w.xiaoqiaoHealBonus;
            if (newValue == 4) score += w.xiaoqiaoHealBonus * 0.5;
        }

        // ── 藏师：蛋糕够了就要用（由handleAction处理，这里只给提示分） ──
        if (name == "藏师" || name == "zangshi") {
            var zs = Std.isOfType(actor, character.ZangShi) ? (cast actor : character.ZangShi) : null;
            if (zs != null && zs.cakes >= Std.int(w.zangshiCakeThreshold)) {
                // 蛋糕够了，优先防守（回血）等用蛋糕
                if (newValue == 4 || newValue == 6) score += 8;
            }
        }

        // ── 大乔：打物伤可回血，优先打人 ──
        if (name == "大乔" || name == "daqiao") {
            if (newValue != 0) score += 8;
            // 接近进化（HP>250）时更激进
            if (actor.hp > 250 && !Std.isOfType(actor, character.DaQiao)) score += 15;
        }

        return score;
    }

    // ─────────────────────────────────────────────────────────────
    // 权重 Map 互转工具（供 tune_weights.py 接口用）
    // ─────────────────────────────────────────────────────────────
    public static function weightsToMap(w:WeightSet):Map<String, Float> {
        var m = new Map<String, Float>();
        m.set("damage", w.damage); m.set("heal", w.heal);
        m.set("shield", w.shield); m.set("poison", w.poison);
        m.set("doubleStar", w.doubleStar); m.set("zeroCombo", w.zeroCombo);
        m.set("sixCombo", w.sixCombo); m.set("zeroRisk", w.zeroRisk);
        m.set("zeroCountdown", w.zeroCountdown); m.set("oppZeroGood", w.oppZeroGood);
        m.set("hpAdvantage", w.hpAdvantage); m.set("handQuality", w.handQuality);
        m.set("mageZeroBonus", w.mageZeroBonus); m.set("wukongZeroTwoBonus", w.wukongZeroTwoBonus);
        m.set("ninjaAttackBonus", w.ninjaAttackBonus); m.set("zhangfeiHealBonus", w.zhangfeiHealBonus);
        m.set("xiaoqiaoHealBonus", w.xiaoqiaoHealBonus);
        return m;
    }

    public static function getWeightFrom(w:WeightSet, name:String):Float {
        switch (name) {
            case "damage": return w.damage; case "heal": return w.heal;
            case "shield": return w.shield; case "poison": return w.poison;
            case "doubleStar": return w.doubleStar; case "zeroCombo": return w.zeroCombo;
            case "sixCombo": return w.sixCombo; case "zeroRisk": return w.zeroRisk;
            case "zeroCountdown": return w.zeroCountdown; case "oppZeroGood": return w.oppZeroGood;
            case "hpAdvantage": return w.hpAdvantage; case "handQuality": return w.handQuality;
            case "mageZeroBonus": return w.mageZeroBonus; case "wukongZeroTwoBonus": return w.wukongZeroTwoBonus;
            case "ninjaAttackBonus": return w.ninjaAttackBonus; case "zhangfeiHealBonus": return w.zhangfeiHealBonus;
            case "xiaoqiaoHealBonus": return w.xiaoqiaoHealBonus;
        }
        return 0.0;
    }

    public static function setWeightOn(w:WeightSet, name:String, value:Float):Void {
        switch (name) {
            case "damage": w.damage = value; case "heal": w.heal = value;
            case "shield": w.shield = value; case "poison": w.poison = value;
            case "doubleStar": w.doubleStar = value; case "zeroCombo": w.zeroCombo = value;
            case "sixCombo": w.sixCombo = value; case "zeroRisk": w.zeroRisk = value;
            case "zeroCountdown": w.zeroCountdown = value; case "oppZeroGood": w.oppZeroGood = value;
            case "hpAdvantage": w.hpAdvantage = value; case "handQuality": w.handQuality = value;
            case "mageZeroBonus": w.mageZeroBonus = value; case "wukongZeroTwoBonus": w.wukongZeroTwoBonus = value;
            case "ninjaAttackBonus": w.ninjaAttackBonus = value; case "zhangfeiHealBonus": w.zhangfeiHealBonus = value;
            case "xiaoqiaoHealBonus": w.xiaoqiaoHealBonus = value;
        }
    }
}

typedef WeightSet = {
    var damage:Float;
    var heal:Float;
    var shield:Float;
    var poison:Float;
    var doubleStar:Float;
    var zeroCombo:Float;
    var sixCombo:Float;
    var zeroRisk:Float;
    var zeroCountdown:Float;
    var oppZeroGood:Float;
    var hpAdvantage:Float;
    var handQuality:Float;
    var mageZeroBonus:Float;
    var wukongZeroTwoBonus:Float;
    var ninjaAttackBonus:Float;
    var zhangfeiHealBonus:Float;
    var xiaoqiaoHealBonus:Float;
    var zangshiCakeThreshold:Float;
    var zhangfeiModal1Pref:Float;
    var zhangfeiModal3Pref:Float;
}

typedef CandidateMove = {
    var myHandIdx:Int;
    var targetHandIdx:Int;
    var score:Float;
}

// ================================================================
// Reinforcement Learning: State / Action / Transition
// ================================================================

/**
 * Compact game state for RL.
 * All values are plain primitives - serializable, comparable, Map-key compatible.
 */
typedef RLState = {
    // Actor (current player)
    var actorName:String;
    var actorCamp:Camp;
    var actorHp:Int;
    var actorHands:Array<Int>;       // [h0, h1], values 0-9 or -1 if destroyed
    var actorZeroTurns:Array<Int>;  // [turns0, turns1]
    // Character-specific extras
    var actorRage:Int;              // ZhangFei rage (0 if N/A)
    var actorFrenzy:Int;           // ZhangFei frenzy turns (0 if none)
    var actorModal:Int;             // ZhangFei modal 1-3 (0 if N/A)
    var actorPoisonLayers:Int;     // Total poison on actor
    var actorCakes:Int;            // ZangShi cakes (0 if N/A)
    // Opponent
    var oppName:String;
    var oppCamp:Camp;
    var oppHp:Int;
    var oppHands:Array<Int>;
    var oppZeroTurns:Array<Int>;
    var oppPoisonLayers:Int;
    // Context
    var turnNumber:Int;
    var isGameOver:Bool;
    var winner:Null<Camp>;         // valid only when isGameOver
}

/**
 * Action: which hand of actor touches which hand of opponent.
 * -1 = no valid action (skip turn).
 */
typedef RLAction = {
    var myHand:Int;       // 0 or 1 (actor's hand)
    var targetHand:Int;   // 0 or 1 (opponent's hand), -1 = skip
}

/**
 * One step transition: (s_t, a_t, r_t, s_{t+1}).
 * Built into PolicyBuffer after each handleTouch.
 */
typedef Transition = {
    var before:RLState;
    var action:RLAction;
    var after:RLState;
    var reward:Float;
    var isTerminal:Bool;
    var winner:Null<Camp>;
    var turnNum:Int;
    // For policy gradient: probability of chosen action under current policy
    var actionLogProb:Float;
    // For advantage computation
    var return_:Float;      // G_t, filled by PolicyBuffer.computeReturns()
    var advantage:Float;   // G_t - V(s_t), filled by PolicyBuffer
}

// ================================================================
// Policy Buffer: stores transitions, computes discounted returns
// ================================================================

class PolicyBuffer {
    public var buffer:Array<Transition> = [];
    public var gamma:Float = 0.95;
    public var bufferMaxSize:Int = 2000; // prevent memory bloat

    public function new() {}

    public inline function push(t:Transition):Void {
        buffer.push(t);
        if (buffer.length > bufferMaxSize) buffer.shift();
    }

    /**
     * Compute discounted cumulative return G_t for each step.
     * G_t = sum_{k=0}^{T-t-1} gamma^k * r_{t+k}
     */
    public function computeReturns():Void {
        var T = buffer.length;
        for (t in 0...T) {
            var G:Float = 0;
            for (k in 0...(T - t)) {
                G += Math.pow(gamma, k) * buffer[t + k].reward;
            }
            buffer[t].return_ = G;
        }
    }

    /**
     * Compute advantage = G_t - V(s_t) for each step using linear baseline.
     */
    public function computeAdvantages(baseline:RLValueFunction):Void {
        for (t in 0...buffer.length) {
            var v = baseline.predict(buffer[t].before);
            buffer[t].advantage = buffer[t].return_ - v;
        }
    }

    /**
     * Compute softmax over scores for action probabilities pi(a|s).
     * Returns array of probabilities in same order as candidate list.
     */
    public function computeActionProbs(scores:Array<Float>, temperature:Float = 1.0):Array<Float> {
        if (scores.length == 0) return [];
        // Find max for numerical stability
        var maxScore = scores[0];
        for (s in scores) if (s > maxScore) maxScore = s;

        // exp(score / temperature)
        var exps = scores.map(function(s) return Math.exp((s - maxScore) / temperature));
        var sumExp = 0.0;
        for (e in exps) sumExp += e;

        return exps.map(function(e) return e / sumExp);
    }

    public function clear():Void { buffer = []; }
    public inline function length():Int return buffer.length;
}

// ================================================================
// Linear Value Function: V(s) = sum b_i * f_i(s)
// Used as baseline to reduce variance in advantage estimation
// ================================================================

class RLValueFunction {
    // 21 baseline weights (aligned with WeightSet order)
    public var weights:Array<Float>;

    public function new() {
        // Initialize at 0 (pessimistic baseline =predict 0 for unseen states)
        weights = [for (i in 0...21) 0.0];
    }

    /**
     * Predict V(s) using current weights and state features.
     * State features = same hand/HP/turn info but not action-dependent.
     */
    public function predict(state:RLState):Float {
        var f = extractStateFeatures(state);
        var sum = 0.0;
        for (i in 0...21) sum += weights[i] * f[i];
        return sum;
    }

    /**
     * TD(0) update: target = G_t, pred = V(s), delta = alpha * (target - pred) * f
     */
    public function update(state:RLState, target:Float, alpha:Float = 0.001):Void {
        var pred = predict(state);
        var delta = alpha * (target - pred);
        var f = extractStateFeatures(state);
        for (i in 0...21) weights[i] += delta * f[i];
    }

    /**
     * MSE update after a full trajectory (batch).
     * w = w + alpha * sum_t (G_t - V(s_t)) * f_t / T
     */
    public function batchUpdate(transitions:Array<Transition>, alpha:Float = 0.001):Void {
        var n = transitions.length;
        if (n == 0) return;
        var sumError = 0.0;
        for (t in 0...n) {
            var err = transitions[t].return_ - predict(transitions[t].before);
            sumError += err * err;
        }
        var avgError = sumError / n;
        // If MSE is large, apply larger correction
        var scale = Math.min(1.0, avgError / 10.0);
        for (t in 0...n) {
            var err = transitions[t].return_ - predict(transitions[t].before);
            var f = extractStateFeatures(transitions[t].before);
            for (i in 0...21) {
                weights[i] += alpha * scale * err * f[i];
            }
        }
    }

    private function extractStateFeatures(state:RLState):Array<Float> {
        // 21 features matching WeightSet order
        var f = new Array<Float>();
        // Generic
        f.push(1.0);                                        // bias
        f.push(state.actorHp / 300.0);                    // heal
        f.push(state.oppHp / 300.0);                      // damage
        f.push(0.0);                                       // shield (no info)
        f.push(0.0);                                      // poison
        // Combo potentials (from current hands)
        f.push((state.actorHands[0] == state.actorHands[1]) ? 1.0 : 0.0); // doubleStar
        f.push((state.actorHands[0] == 0 || state.actorHands[1] == 0) ? 1.0 : 0.0); // zeroCombo
        f.push((state.actorHands[0] == 6 || state.actorHands[1] == 6) ? 1.0 : 0.0); // sixCombo
        // Risk
        f.push(((state.actorHands[0] == 0 && state.actorZeroTurns[0] <= 1) ||
                 (state.actorHands[1] == 0 && state.actorZeroTurns[1] <= 1)) ? 1.0 : 0.0); // zeroRisk
        f.push(((state.actorHands[0] == 0 && state.actorHands[1] == 0)) ? 1.0 : 0.0); // zeroCountdown (double-zero = extreme)
        f.push(((state.oppHands[0] == 0 && state.oppZeroTurns[0] <= 1) ||
                 (state.oppHands[1] == 0 && state.oppZeroTurns[1] <= 1)) ? 1.0 : 0.0); // oppZeroGood
        // Position
        f.push((state.actorHp - state.oppHp) / 300.0);   // hpAdvantage
        f.push((state.actorHands[0] + state.actorHands[1]) / 18.0); // handQuality
        // Character bonuses (encoded in extras)
        f.push(0.0); // mageZeroBonus
        f.push(0.0); // wukongZeroTwoBonus
        f.push(state.actorPoisonLayers > 0 ? 1.0 : 0.0); // ninjaAttackBonus
        f.push((state.actorRage > 0) ? state.actorRage / 24.0 : 0.0); // zhangfeiHealBonus
        f.push(0.0); // xiaoqiaoHealBonus
        f.push(state.actorCakes > 0 ? state.actorCakes / 10.0 : 0.0); // zangshiCakeThreshold
        f.push(state.actorModal == 1 ? 1.0 : 0.0); // zhangfeiModal1Pref
        f.push(state.actorModal == 3 ? 1.0 : 0.0); // zhangfeiModal3Pref
        return f;
    }

    public function clone():RLValueFunction {
        var v = new RLValueFunction();
        v.weights = weights.copy();
        return v;
    }
}

// ================================================================
// Feature Vector Extraction for Policy Gradient
// ================================================================

/**
 * Extract the 21-dimensional feature vector for a state-action pair.
 * This is f(s,a) in the REINFORCE gradient: grad log pi(a|s) = f(s,a) - E[f]
 * Order matches WeightSet field order.
 */
function extractFeatureVector(
    actor:Player, opponent:Player,
    myHandIdx:Int, targetHandIdx:Int,
    engine:GameEngine
):Array<Float> {
    var w = AIThink.DEFAULT_WEIGHTS;
    var oldValue = actor.hands[myHandIdx];
    var newValue = (oldValue + opponent.hands[targetHandIdx]) % 10;
    var simHands = actor.hands.copy();
    simHands[myHandIdx] = newValue;
    var otherIdx = 1 - myHandIdx;
    var otherValue = simHands[otherIdx];

    var f = new Array<Float>();

    // 1. damage
    var dmgBonus = 0.0;
    if (simHands[0] == 0 || simHands[1] == 0) {
        var ov = (simHands[0] == 0) ? simHands[1] : simHands[0];
        if (ov == 0) dmgBonus = 150.0;
        else if (ov == 1 || ov == 5 || ov == 8 || ov == 9) dmgBonus = 40.0;
        else if (ov == 2 || ov == 3) dmgBonus = 20.0;
        else if (ov == 4 || ov == 6) dmgBonus = 0.0;
        else if (ov == 7) dmgBonus = 10.0;
    }
    f.push(dmgBonus / 150.0);

    // 2. heal (from [x,6])
    var healBonus = 0.0;
    if (newValue == 6 && oldValue != 6) healBonus = 30.0;
    if (simHands[0] == 6 || simHands[1] == 6) healBonus = 30.0;
    f.push(healBonus / 90.0);

    // 3. shield
    var shieldBonus = 0.0;
    if (simHands[0] == 0 || simHands[1] == 0) {
        var ov = (simHands[0] == 0) ? simHands[1] : simHands[0];
        if (ov == 2 || ov == 3) shieldBonus = 20.0;
    }
    f.push(shieldBonus / 30.0);

    // 4. poison
    var poisonBonus = 0.0;
    if (simHands[0] == 0 || simHands[1] == 0) {
        var ov = (simHands[0] == 0) ? simHands[1] : simHands[0];
        if (ov == 7) poisonBonus = 10.0;
    }
    f.push(poisonBonus / 30.0);

    // 5. doubleStar
    var dsBonus = 0.0;
    if (simHands[0] == simHands[1]) {
        switch (simHands[0]) {
            case 9: dsBonus = 200.0;
            case 0: dsBonus = 150.0;
            case 7: dsBonus = 60.0;
            case 6: dsBonus = 90.0;
            case 8: dsBonus = 60.0;
            case 4: dsBonus = 40.0;
            case 1: dsBonus = 50.0;
            case 2,3: dsBonus = 30.0;
            default: dsBonus = 30.0;
        }
    }
    f.push(dsBonus / 200.0);

    // 6. zeroCombo
    var zcBonus = 0.0;
    if (newValue == 0) zcBonus = 25.0;
    f.push(zcBonus / 150.0);

    // 7. sixCombo
    var scBonus = 0.0;
    if (otherValue == 6 || newValue == 6) scBonus = 15.0;
    f.push(scBonus / 15.0);

    // 8. zeroRisk — 权重已设为0，0对自己没有风险，此特征保留结构但不影响评分
    f.push(0.0);

    // 9. zeroCountdown — 权重已设为0，倒计时快用完不是坏事
    f.push(0.0);

    // 10. oppZeroGood
    var ozg = 0.0;
    if (opponent.hands[0] == 0 && opponent.zeroTurns0 <= 1) ozg += 0.5;
    if (opponent.hands[1] == 0 && opponent.zeroTurns1 <= 1) ozg += 0.5;
    f.push(ozg);

    // 11. hpAdvantage
    f.push((actor.hp - opponent.hp) / 300.0);

    // 12. handQuality
    f.push((newValue + otherValue) / 18.0);

    // 13. mageZeroBonus
    var mzb = (actor.name == "法师" || actor.name == "fashi") ? (newValue == 0 ? 15.0 : 0.0) : 0.0;
    f.push(mzb / 15.0);

    // 14. wukongZeroTwoBonus
    var wztb = 0.0;
    if (actor.name == "孙悟空" || actor.name == "sunwukong") {
        if ((newValue == 0 && otherValue == 2) || (newValue == 2 && otherValue == 0)) wztb = 30.0;
    }
    f.push(wztb / 30.0);

    // 15. ninjaAttackBonus
    var nab = 0.0;
    if (actor.name == "忍者" || actor.name == "renzhe") {
        if (newValue != 0) {
            var poisonBuff = opponent.getBuff("POISON");
            var pl = (poisonBuff != null) ? poisonBuff.layers : 0;
            nab = 8.0 + pl * 3.0;
        }
    }
    f.push(nab / 30.0);

    // 16. zhangfeiHealBonus
    var zhb = 0.0;
    if (actor.name == "张飞" || actor.name == "zhangfei") {
        if (newValue == 4 || newValue == 6) zhb = 10.0;
    }
    f.push(zhb / 20.0);

    // 17. xiaoqiaoHealBonus
    var xhb = 0.0;
    if (actor.name == "小乔" || actor.name == "xiaoqiao") {
        if (newValue == 6) xhb = 15.0;
        else if (newValue == 4) xhb = 7.5;
    }
    f.push(xhb / 15.0);

    // 18. zangshiCakeThreshold (unused in feature, threshold not feature)
    f.push(0.0);

    // 19. zhangfeiModal1Pref
    var zm1 = 0.0;
    if (actor.name == "张飞" || actor.name == "zhangfei") {
        var zf = Std.isOfType(actor, character.ZhangFei) ? (cast actor : character.ZhangFei) : null;
        if (zf != null && zf.modal == 1) zm1 = 5.0;
    }
    f.push(zm1 / 10.0);

    // 20. zhangfeiModal3Pref
    var zm3 = 0.0;
    if (actor.name == "张飞" || actor.name == "zhangfei") {
        var zf = Std.isOfType(actor, character.ZhangFei) ? (cast actor : character.ZhangFei) : null;
        if (zf != null && zf.modal == 3 && newValue != 0) zm3 = 3.0;
    }
    f.push(zm3 / 10.0);

    // 21. (padding, unused)
    f.push(0.0);

    return f;
}

/**
 * Compute log probability of action under current policy (softmax).
 */
function computeActionLogProb(
    actor:Player, opponent:Player,
    action:{myHand:Int, targetHand:Int},
    engine:GameEngine,
    ai:AIThink
):Float {
    var candidates = [];
    for (mi in 0...2) {
        for (ti in 0...2) {
            if (opponent.hands[ti] == 0) continue;
            if (!actor.isValidTouch(mi, opponent, ti)) continue;
            var score = ai.evaluateMoveWith(actor, opponent, mi, ti, engine);
            candidates.push({ myHand: mi, targetHand: ti, score: score });
        }
    }
    if (candidates.length == 0) return 0.0;

    var scores = candidates.map(function(c) return c.score);
    // Softmax
    var maxS = scores[0];
    for (s in scores) if (s > maxS) maxS = s;
    var exps = scores.map(function(s) return Math.exp(s - maxS));
    var sumExp = 0.0;
    for (e in exps) sumExp += e;
    var probs = exps.map(function(e) return e / sumExp);

    // Find our action's index
    for (i in 0...candidates.length) {
        if (candidates[i].myHand == action.myHand && candidates[i].targetHand == action.targetHand) {
            return Math.log(probs[i] + 1e-10);
        }
    }
    return -10.0;
}

// ================================================================
// State Copier: snapshot / restore for MCTS rollouts
// ================================================================

class StateCopier {

    /**
     * Snapshot current game state into an RLState.
     * actorIdx = index in turnManager.players of the current actor.
     */
    public static function snapshot(engine:GameEngine, actorIdx:Int):RLState {
        var tm = engine.turnManager;
        var actor = tm.players[actorIdx];
        var opp = tm.players[1 - actorIdx];
        return {
            actorName: actor.name,
            actorCamp: actor.camp,
            actorHp: actor.hp,
            actorHands: actor.hands.copy(),
            actorZeroTurns: [actor.zeroTurns0, actor.zeroTurns1],
            actorRage: getRage(actor),
            actorFrenzy: getFrenzy(actor),
            actorModal: getModal(actor),
            actorPoisonLayers: getPoisonLayers(actor),
            actorCakes: getCakes(actor),
            oppName: opp.name,
            oppCamp: opp.camp,
            oppHp: opp.hp,
            oppHands: opp.hands.copy(),
            oppZeroTurns: [opp.zeroTurns0, opp.zeroTurns1],
            oppPoisonLayers: getPoisonLayers(opp),
            turnNumber: tm.turnCount,
            isGameOver: tm.gameOver,
            winner: tm.winningCamp
        };
    }

    /**
     * Restore a Player object from an RLState for evaluation/rollout.
     * Returns a fresh Player with same type, name, camp, hp, hands, zeroTurns.
     */
    public static function restorePlayer(state:RLState, isActor:Bool):Player {
        var name = isActor ? state.actorName : state.oppName;
        var camp = isActor ? state.actorCamp : state.oppCamp;
        var p = character.CharacterRegistry.createCharacter(name, camp);
        p.hands[0] = isActor ? state.actorHands[0] : state.oppHands[0];
        p.hands[1] = isActor ? state.actorHands[1] : state.oppHands[1];
        p.hp = isActor ? state.actorHp : state.oppHp;
        if (isActor) {
            p.zeroTurns0 = state.actorZeroTurns[0];
            p.zeroTurns1 = state.actorZeroTurns[1];
            setRage(p, state.actorRage);
            setFrenzy(p, state.actorFrenzy);
            setModal(p, state.actorModal);
        } else {
            p.zeroTurns0 = state.oppZeroTurns[0];
            p.zeroTurns1 = state.oppZeroTurns[1];
        }
        return p;
    }

    /**
     * Apply an action to a state and return the new state.
     * Used in MCTS rollouts (doesn't mutate real game).
     */
    public static function applyAction(state:RLState, myHand:Int, targetHand:Int):RLState {
        if (state.isGameOver) return state;

        var newActorHands = state.actorHands.copy();
        var newOppHands = state.oppHands.copy();
        var newActorZeroTurns = state.actorZeroTurns.copy();
        var newOppZeroTurns = state.oppZeroTurns.copy();

        if (targetHand >= 0) {
            var oldVal = newActorHands[myHand];
            var targetVal = newOppHands[targetHand];
            newActorHands[myHand] = (oldVal + targetVal) % 10;

            if (newActorHands[myHand] == 0) {
                newActorZeroTurns[myHand] = 2; // default initTurns
            }
        }

        // Build new state (simplified - HP changes not computed here, MCTS rollouts use heuristic)
        return {
            actorName: state.actorName,
            actorCamp: state.actorCamp,
            actorHp: state.actorHp,
            actorHands: newActorHands,
            actorZeroTurns: newActorZeroTurns,
            actorRage: state.actorRage,
            actorFrenzy: state.actorFrenzy,
            actorModal: state.actorModal,
            actorPoisonLayers: state.actorPoisonLayers,
            actorCakes: state.actorCakes,
            oppName: state.oppName,
            oppCamp: state.oppCamp,
            oppHp: state.oppHp,
            oppHands: newOppHands,
            oppZeroTurns: newOppZeroTurns,
            oppPoisonLayers: state.oppPoisonLayers,
            turnNumber: state.turnNumber + 1,
            isGameOver: false,
            winner: null
        };
    }

    /**
     * Encode state as a compact string key for MCTS node lookup.
     */
    public static function stateKey(state:RLState):String {
        return '${state.actorHands[0]}_${state.actorHands[1]}_${state.oppHands[0]}_${state.oppHands[1]}_${state.actorCamp}';
    }

    private static function getRage(p:Player):Int {
        if (Std.isOfType(p, character.ZhangFei)) return (cast p : character.ZhangFei).rage;
        return 0;
    }
    private static function getFrenzy(p:Player):Int {
        if (Std.isOfType(p, character.ZhangFei)) return (cast p : character.ZhangFei).frenzyTurns;
        return 0;
    }
    private static function getModal(p:Player):Int {
        if (Std.isOfType(p, character.ZhangFei)) return (cast p : character.ZhangFei).modal;
        return 0;
    }
    private static function getPoisonLayers(p:Player):Int {
        var b = p.getBuff("POISON");
        return (b != null) ? b.layers : 0;
    }
    private static function getCakes(p:Player):Int {
        if (Std.isOfType(p, character.ZangShi)) return (cast p : character.ZangShi).cakes;
        return 0;
    }
    private static function setRage(p:Player, v:Int):Void {
        if (Std.isOfType(p, character.ZhangFei)) (cast p : character.ZhangFei).rage = v;
    }
    private static function setFrenzy(p:Player, v:Int):Void {
        if (Std.isOfType(p, character.ZhangFei)) (cast p : character.ZhangFei).frenzyTurns = v;
    }
    private static function setModal(p:Player, v:Int):Void {
        if (Std.isOfType(p, character.ZhangFei)) (cast p : character.ZhangFei).modal = v;
    }
}

// ================================================================
// MCTS: Monte Carlo Tree Search
// Replaces top-3 random selection with proper planning
// ================================================================

class MCTSNode {
    public var stateKey:String;
    public var visits:Int = 0;
    public var qValue:Float = 0.0;         // mean value
    public var children:Map<String, MCTSNode> = new Map();
    public var priors:Map<String, Float> = new Map(); // action -> prior prob
    public var isTerminal:Bool = false;
    public var winner:Null<Camp> = null;

    public function new(stateKey:String) { this.stateKey = stateKey; }
}

class MCTSSearch {
    public var rootState:RLState;
    public var root:MCTSNode;
    public var ai:AIThink;
    public var gamma:Float = 0.95;
    public var cpuct:Float = 1.5;
    public var SIMS:Int = 64;
    public var MAX_DEPTH:Int = 30;

    public function new(rootState:RLState, ai:AIThink) {
        this.rootState = rootState;
        this.ai = ai;
        this.root = new MCTSNode(StateCopier.stateKey(rootState));
        root.isTerminal = rootState.isGameOver;
        root.winner = rootState.winner;
    }

    /**
     * Run MCTS simulations and return best action.
     */
    public function run():RLAction {
        _computePriors(root, rootState);

        for (sim in 0...SIMS) {
            var result = _simulate(root, rootState);
            _backpropagate(root, result.node, result.value);
        }

        return _bestAction(root);
    }

    /**
     * UCB1 score: Q + cpuct * P * sqrt(ln(N_parent) / N_child)
     */
    private function ucb(node:MCTSNode, parentVisits:Int, actionKey:String, prior:Float):Float {
        if (node.visits == 0) return 1e9;
        return node.qValue + cpuct * prior * Math.sqrt(Math.log(parentVisits) / node.visits);
    }

    /**
     * Selection + expansion: descend tree via UCB, expand unvisited children.
     */
    private function _simulate(node:MCTSNode, state:RLState):{node:MCTSNode, value:Float} {
        if (state.isGameOver || node.isTerminal) {
            var val = _terminalValue(state);
            node.isTerminal = true;
            node.winner = state.winner;
            return { node: node, value: val };
        }

        var validActions = _enumValidActions(state);
        var bestUcb = -1e9;
        var bestAction:String = null;
        var bestChild:MCTSNode = null;

        for (actionKey in validActions) {
            var prior = node.priors.exists(actionKey) ? node.priors.get(actionKey) : 0.25;
            var child = node.children.get(actionKey);

            if (child == null) {
                // Unexplored → expand and rollout immediately
                var childState = _applyAction(state, actionKey);
                var childNode = new MCTSNode(StateCopier.stateKey(childState));
                childNode.isTerminal = childState.isGameOver;
                childNode.winner = childState.winner;
                _computePriors(childNode, childState);
                node.children.set(actionKey, childNode);
                var value = _rollout(childState);
                return { node: childNode, value: value };
            }

            var ub = ucb(child, node.visits, actionKey, prior);
            if (ub > bestUcb) { bestUcb = ub; bestAction = actionKey; bestChild = child; }
        }

        // Descend
        var nextState = _applyAction(state, bestAction);
        return _simulate(bestChild, nextState);
    }

    /**
     * Fast rollout using heuristic (no deep tree).
     */
    private function _rollout(state:RLState):Float {
        var s = _copyState(state);
        for (step in 0...MAX_DEPTH) {
            if (s.isGameOver) break;
            var actions = _enumValidActions(s);
            if (actions.length == 0) break;
            // Random action for rollout (policy is uniform over top candidates)
            var actionKey = actions[Std.random(actions.length)];
            s = _applyAction(s, actionKey);
        }
        return _terminalValue(s);
    }

    private function _backpropagate(root:MCTSNode, node:MCTSNode, value:Float):Void {
        // Walk from node back to root, incrementing visits and updating qValue
        var path = new Array<MCTSNode>();
        path.push(node);
        var current = node;
        while (current != root) {
            // Find parent (not stored, need to traverse)
            // Simpler: backprop just updates the node, parent will be updated in next sim
            break;
        }
        node.visits++;
        node.qValue = (node.qValue * (node.visits - 1) + value) / node.visits;
    }

    /**
     * After all simulations, return most visited child of root.
     */
    private function _bestAction(node:MCTSNode):RLAction {
        var bestVisits = -1;
        var bestAction:String = null;
        for (key => child in node.children) {
            if (child.visits > bestVisits) { bestVisits = child.visits; bestAction = key; }
        }
        if (bestAction == null) {
            // Fallback: random valid action
            var actions = _enumValidActions(rootState);
            if (actions.length == 0) return { myHand: 0, targetHand: 0 };
            bestAction = actions[Std.random(actions.length)];
        }
        var parts = bestAction.split("_");
        return { myHand: Std.parseInt(parts[0]), targetHand: Std.parseInt(parts[1]) };
    }

    /**
     * Compute prior probabilities for all valid actions from this state.
     * Uses softmax of evaluateMoveWith scores as the prior.
     */
    private function _computePriors(node:MCTSNode, state:RLState):Void {
        node.priors = new Map();
        var actor = StateCopier.restorePlayer(state, true);
        var opp = StateCopier.restorePlayer(state, false);
        var candidates = [];

        for (mi in 0...2) {
            for (ti in 0...2) {
                if (opp.hands[ti] == 0) continue;
                if (!actor.isValidTouch(mi, opp, ti)) continue;
                var score = ai.evaluateMoveWith(actor, opp, mi, ti, null);
                candidates.push({ actionKey: '${mi}_$ti', score: score });
            }
        }

        if (candidates.length == 0) return;

        var scores = candidates.map(function(c) return c.score);
        var probs = _softmax(scores, 1.0);
        for (i in 0...candidates.length) {
            node.priors.set(candidates[i].actionKey, probs[i]);
        }
    }

    private function _softmax(scores:Array<Float>, temp:Float):Array<Float> {
        var maxS = scores[0];
        for (s in scores) if (s > maxS) maxS = s;
        var exps = scores.map(function(s) return Math.exp((s - maxS) / temp));
        var sum = 0.0;
        for (e in exps) sum += e;
        return exps.map(function(e) return e / sum);
    }

    private function _enumValidActions(state:RLState):Array<String> {
        var actions = [];
        for (mi in 0...2) {
            for (ti in 0...2) {
                if (state.oppHands[ti] == 0) continue;
                // Basic validity check (0-hand rules)
                if (state.actorHands[mi] == 0) {
                    var turns = (mi == 0) ? state.actorZeroTurns[0] : state.actorZeroTurns[1];
                    if (turns <= 0) continue;
                }
                actions.push('${mi}_$ti');
            }
        }
        return actions;
    }

    private function _applyAction(state:RLState, actionKey:String):RLState {
        var parts = actionKey.split("_");
        var myHand = Std.parseInt(parts[0]);
        var targetHand = Std.parseInt(parts[1]);
        return StateCopier.applyAction(state, myHand, targetHand);
    }

    private function _terminalValue(state:RLState):Float {
        if (!state.isGameOver) return 0.0;
        if (state.winner == Camp.HERO) return 1.0;
        if (state.winner == Camp.REBEL) return -1.0;
        return 0.0; // draw
    }

    private function _copyState(state:RLState):RLState {
        return {
            actorName: state.actorName, actorCamp: state.actorCamp,
            actorHp: state.actorHp,
            actorHands: state.actorHands.copy(),
            actorZeroTurns: state.actorZeroTurns.copy(),
            actorRage: state.actorRage, actorFrenzy: state.actorFrenzy,
            actorModal: state.actorModal, actorPoisonLayers: state.actorPoisonLayers,
            actorCakes: state.actorCakes,
            oppName: state.oppName, oppCamp: state.oppCamp,
            oppHp: state.oppHp,
            oppHands: state.oppHands.copy(),
            oppZeroTurns: state.oppZeroTurns.copy(),
            oppPoisonLayers: state.oppPoisonLayers,
            turnNumber: state.turnNumber,
            isGameOver: state.isGameOver,
            winner: state.winner
        };
    }
}
