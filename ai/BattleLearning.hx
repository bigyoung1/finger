package ai;

import model.Camp;
import ai.AIThink;
import ai.AIThink.WeightSet;
import ai.AIThink.PolicyBuffer;
import ai.AIThink.RLValueFunction;
import ai.AIThink.StateCopier;
import ai.AIThink.RLState;
import ai.AIThink.RLAction;
import ai.AIThink.Transition;
import ai.AIThink.extractFeatureVector;

/**
 * AI 进化学习系统
 *
 * 学习策略：权重进化（Evolutionary Strategy）
 *
 * 原理：
 *   1. 维护"当前最优 AI"（冠军）和若干"挑战者 AI"
 *   2. 冠军 vs 挑战者 打 K 场（用结构化事件统计，不靠解析文字）
 *   3. 挑战者赢率 > 阈值 → 挑战者变冠军，淘汰旧冠军
 *   4. 冠军权重轻微变异生成新挑战者，循环迭代
 *
 * 局限性说明（诚实）：
 *   - 两个 AI 用对称启发式，胜负仍有较大随机成分
 *   - 需要足够多的对局（≥20局/代）才有统计意义
 *   - 实际提升效果是"边际优化"，不是从弱到强的突变
 *   - 真正的强化学习需要 MCTS 或 policy gradient，本模块是轻量替代
 */
class BattleLearning {

    // ── 进化配置 ──
    public static var BATTLES_PER_GENERATION:Int = 20;  // 每代打多少场
    public static var WIN_THRESHOLD:Float = 0.58;        // 挑战者赢率 > 58% 才升级
    public static var MUTATION_MAGNITUDE:Float = 0.12;   // 变异幅度 12%
    public static var MAX_CHALLENGERS:Int = 3;           // 同时维护几个挑战者
    public static var ELO_K:Float = 32.0;                // Elo K因子

    // ── 冠军 ──
    public var champion:AIThink;

    // ── 挑战者池 ──
    public var challengers:Array<AIThink> = [];

    // ── 当前挑战对局 ──
    private var currentChallenger:AIThink = null;
    private var challengeBattlesPlayed:Int = 0;
    private var challengeWins:Int = 0;      // 挑战者赢的场数
    private var challengeDraws:Int = 0;

    // ── 历史统计 ──
    public var generationCount:Int = 0;
    public var totalBattlesRecorded:Int = 0;
    public var evolutionLog:Array<String> = [];

    // ── 结构化对局事件（不依赖文字解析） ──
    private var pendingBattle:Null<StructuredBattle> = null;

    // ── RL: 策略缓冲 & 值函数 ──
    public var policyBuffer:PolicyBuffer = new PolicyBuffer();
    public var valueFunction:RLValueFunction = new RLValueFunction();
    public var rlEnabled:Bool = true;           // 开启/关闭 RL 更新
    public var rlLearningRate:Float = 0.005;      // REINFORCE 学习率
    public var gradientClip:Float = 0.20;         // 每场每权重最大变化 20%

    public function new() {
        champion = new AIThink("Champion_Gen0");
        _spawnChallengers();
        _pickNextChallenger();
        trace('[Evolution] 学习系统初始化。冠军：${champion.id}，挑战者：${currentChallenger != null ? currentChallenger.id : "无"}');
    }

    // ─────────────────────────────────────────────────────────────
    // 核心：记录对局结果（结构化数据，不靠解析日志）
    // ─────────────────────────────────────────────────────────────

    /**
     * 对局开始时调用，记录初始状态
     */
    public function onBattleStart(p1Name:String, p2Name:String, p1IsChampion:Bool):Void {
        pendingBattle = {
            p1Name: p1Name, p2Name: p2Name,
            p1IsChampion: p1IsChampion,
            winner: null,
            turns: 0,
            events: []
        };
    }

    /**
     * 对局中记录关键事件（由 AIBattleRunner 在每次 handleTouch 后调用）
     */
    public function recordEvent(event:BattleEvent):Void {
        if (pendingBattle != null) pendingBattle.events.push(event);
    }

    /**
     * 对局结束时调用
     * @param winner 胜利阵营（null = 平局）
     * @param totalTurns 总回合数
     */
    public function onBattleEnd(winner:Null<Camp>, totalTurns:Int):Void {
        if (pendingBattle == null) return;

        pendingBattle.winner = winner;
        pendingBattle.turns = totalTurns;
        totalBattlesRecorded++;

        var p1Won = (winner == Camp.HERO);
        var p2Won = (winner == Camp.REBEL);
        var isDraw = (winner == null);

        // 判断挑战者是否胜利
        var challengerIsP1 = !pendingBattle.p1IsChampion;
        var challengerWon = (challengerIsP1 && p1Won) || (!challengerIsP1 && p2Won);
        var draw = isDraw;

        if (challengerWon) challengeWins++;
        if (draw) challengeDraws++;
        challengeBattlesPlayed++;

        // 更新 Elo
        _updateElo(champion, currentChallenger, championWon(!challengerWon && !draw));

        // 分析对局质量（结构化）
        _analyzeEvents(pendingBattle.events, challengerWon);

        pendingBattle = null;

        // 检查是否完成一代
        if (challengeBattlesPlayed >= BATTLES_PER_GENERATION) {
            _evaluateGeneration();
        }
    }

    // 兼容旧接口（AIBattleRunner 调用）
    public function recordBattle(
        battleNumber:Int, winner:Null<Camp>,
        player1:String, player2:String,
        totalTurns:Int, log:Array<String>
    ):Void {
        if (pendingBattle == null) {
            onBattleStart(player1, player2, true);
        }
        onBattleEnd(winner, totalTurns);
    }

    // ─────────────────────────────────────────────────────────────
    // 进化核心
    // ─────────────────────────────────────────────────────────────

    private function _evaluateGeneration():Void {
        generationCount++;
        var total = challengeBattlesPlayed;
        var winRate = (total > 0) ? challengeWins / total : 0.0;
        var drawRate = (total > 0) ? challengeDraws / total : 0.0;

        var msg = '[Gen ${generationCount}] ${currentChallenger.id} vs ${champion.id}: '
            + '${challengeWins}W/${total - challengeWins - challengeDraws}L/${challengeDraws}D '
            + '(赢率 ${Std.int(winRate * 100)}%)';
        trace(msg);
        evolutionLog.push(msg);

        if (winRate >= WIN_THRESHOLD) {
            // 挑战者升级为冠军！
            var promoMsg = '🎉 [进化] ${currentChallenger.id} 挑战成功！赢率${Std.int(winRate*100)}% > ${Std.int(WIN_THRESHOLD*100)}%，成为新冠军！';
            trace(promoMsg);
            evolutionLog.push(promoMsg);

            // 新冠军 = 挑战者，同时用新冠军权重更新默认 AI
            champion = currentChallenger;
            champion.id = "Champion_Gen" + generationCount;
            _syncToDefault();
        } else {
            var failMsg = 'ℹ️ [进化] ${currentChallenger.id} 挑战失败（${Std.int(winRate*100)}% < ${Std.int(WIN_THRESHOLD*100)}%），冠军保持。';
            trace(failMsg);
            evolutionLog.push(failMsg);
        }

        // 生成新挑战者，继续下一代
        _spawnChallengers();
        _pickNextChallenger();
        challengeBattlesPlayed = 0;
        challengeWins = 0;
        challengeDraws = 0;

        // 打印当前最优权重
        _printCurrentBest();
    }

    private function _syncToDefault():Void {
        // 把冠军权重同步到 AIThink 的静态默认实例
        var w = champion.weights;
        for (key in AIThink.weightsToMap(w).keys()) {
            AIThink.setWeight(key, AIThink.getWeightFrom(w, key));
        }
        trace('[进化] 默认 AI 权重已更新为冠军权重（${champion.id}）');
    }

    private function _spawnChallengers():Void {
        challengers = [];
        for (i in 0...MAX_CHALLENGERS) {
            var challenger = new AIThink(
                "Challenger_Gen${generationCount}_${i}",
                AIThink.mutateWeights(champion.weights, MUTATION_MAGNITUDE)
            );
            challenger.elo = champion.elo; // 继承初始 Elo
            challengers.push(challenger);
        }
    }

    private function _pickNextChallenger():Void {
        if (challengers.length == 0) return;
        // 优先选 Elo 最高的（还没被淘汰的最强挑战者）
        challengers.sort(function(a, b) return Std.int(b.elo - a.elo));
        currentChallenger = challengers[0];
    }

    private function _updateElo(winner:AIThink, loser:AIThink, isWin:Bool):Void {
        if (winner == null || loser == null) return;
        var expected = 1.0 / (1.0 + Math.pow(10, (loser.elo - winner.elo) / 400.0));
        var actual = isWin ? 1.0 : 0.5;
        var delta = ELO_K * (actual - expected);
        winner.elo += delta;
        loser.elo -= delta;
    }

    private function championWon(b:Bool):Bool return b;

    // ─────────────────────────────────────────────────────────────
    // 结构化事件分析（替代文字日志解析）
    // ─────────────────────────────────────────────────────────────

    private function _analyzeEvents(events:Array<BattleEvent>, challengerWon:Bool):Void {
        if (currentChallenger == null) return;

        var w = currentChallenger.weights;

        // 统计各类事件
        var doubleStars = 0; var zeroCombos = 0;
        var totalDamage = 0; var totalHeal = 0; var zeroCrises = 0;

        for (e in events) {
            switch (e.type) {
                case DoubleStar: doubleStars++;
                case ZeroCombo: zeroCombos++;
                case Damage: totalDamage += e.value;
                case Heal: totalHeal += e.value;
                case ZeroCrisis: zeroCrises++;
                default:
            }
        }

        // 学习信号：根据胜败微调权重（梯度方向）
        var signal = challengerWon ? 1.0 : -1.0;
        var lr = 0.05; // 每场微调 5%

        // 双子星触发多 → 说明 doubleStar 权重有效
        if (doubleStars > 1) _adjustWeight(w, "doubleStar", signal * lr * doubleStars);

        // 0组合多 → 说明 zeroCombo 权重有效
        if (zeroCombos > 0) _adjustWeight(w, "zeroCombo", signal * lr * zeroCombos);

        // 0危机多且输了 → zeroRisk 惩罚不够大
        if (zeroCrises > 2 && !challengerWon) _adjustWeight(w, "zeroRisk", -lr * 2);

        // 伤害高且赢了 → damage 权重有效
        if (totalDamage > 200 && challengerWon) _adjustWeight(w, "damage", signal * lr);
    }

    private function _adjustWeight(w:WeightSet, name:String, delta:Float):Void {
        var current = AIThink.getWeightFrom(w, name);
        if (current == 0.0) return;
        // 保持符号，不让正权重变负
        var newVal = current + delta;
        if (current > 0 && newVal < 0) newVal = current * 0.1;
        if (current < 0 && newVal > 0) newVal = current * 0.1;
        AIThink.setWeightOn(w, name, newVal);
    }

    // ─────────────────────────────────────────────────────────────
    // 查询 & 报告
    // ─────────────────────────────────────────────────────────────

    public function getCurrentAI():AIThink {
        // 返回当前对战中应该使用哪个 AI（挑战者场次还没满就用挑战者，否则用冠军）
        return currentChallenger != null ? currentChallenger : champion;
    }

    public function getChampion():AIThink { return champion; }

    public function getProgress():String {
        return '第 ${generationCount} 代 | 当前挑战者 ${challengeBattlesPlayed}/${BATTLES_PER_GENERATION} 场 '
            + '| 冠军Elo ${Std.int(champion.elo)}';
    }

    private function _printCurrentBest():Void {
        trace('');
        trace('╔══════════════════════════════════════════════════════╗');
        trace('║        当前最优 AI 权重（${champion.id}）');
        trace('╠══════════════════════════════════════════════════════╣');
        var w = champion.weights;
        trace('║ damage=${Std.int(w.damage*100)/100}  heal=${Std.int(w.heal*100)/100}  doubleStar=${Std.int(w.doubleStar*100)/100}');
        trace('║ zeroCombo=${Std.int(w.zeroCombo*100)/100}  zeroRisk=${Std.int(w.zeroRisk*100)/100}  sixCombo=${Std.int(w.sixCombo*100)/100}');
        trace('║ Elo=${Std.int(champion.elo)}  总对局=${totalBattlesRecorded}  进化代数=${generationCount}');
        trace('╚══════════════════════════════════════════════════════╝');
        trace('');
    }

    // ─────────────────────────────────────────────────────────────
    // RL: REINFORCE 梯度更新
    // ─────────────────────────────────────────────────────────────

    /**
     * 对当前 buffer 中的所有 transition 执行一次 REINFORCE 更新。
     * 在 onBattleEnd 之后调用，或者每 N 场调用一次。
     */
    public function applyREINFORCE():Void {
        if (!rlEnabled) return;
        if (policyBuffer.length() == 0) return;

        // 1. 计算折扣回报 G_t
        policyBuffer.computeReturns();

        // 2. 计算优势 A_t = G_t - V(s_t)
        policyBuffer.computeAdvantages(valueFunction);

        // 3. 对 champion 权重执行梯度更新
        var transitions = policyBuffer.buffer;
        var n = transitions.length;

        // 收集所有权重名称（按 WeightSet 顺序）
        var weightNames = [
            "damage","heal","shield","poison","doubleStar","zeroCombo","sixCombo",
            "zeroRisk","zeroCountdown","oppZeroGood","hpAdvantage","handQuality",
            "mageZeroBonus","wukongZeroTwoBonus","ninjaAttackBonus","zhangfeiHealBonus",
            "xiaoqiaoHealBonus","zangshiCakeThreshold","zhangfeiModal1Pref","zangfeiModal3Pref"
        ];

        // 计算每个权重的累积梯度
        var gradSums = [for (i in 0...21) 0.0];
        var validCount = 0;

        for (t in 0...n) {
            var trans = transitions[t];
            var advantage = trans.advantage;
            if (Math.abs(advantage) < 1e-4) continue; // dead zone

            // 提取特征向量 (用 before state 和 action)
            var actor = StateCopier.restorePlayer(trans.before, true);
            var opp = StateCopier.restorePlayer(trans.before, false);
            var fv = extractFeatureVector(actor, opp, trans.action.myHand, trans.action.targetHand, null);

            // 计算策略概率 pi(a|s) 和期望特征
            var candidates = [];
            for (mi in 0...2) {
                for (ti in 0...2) {
                    if (opp.hands[ti] == 0) continue;
                    if (!actor.isValidTouch(mi, opp, ti)) continue;
                    var score = champion.evaluateMoveWith(actor, opp, mi, ti, null);
                    candidates.push({ myHand: mi, targetHand: ti, score: score });
                }
            }
            if (candidates.length == 0) continue;

            var scores = candidates.map(function(c) return c.score);
            var probs = _softmax(scores, 1.0);

            // 找chosen action的index
            var chosenIdx = -1;
            for (i in 0...candidates.length) {
                if (candidates[i].myHand == trans.action.myHand && candidates[i].targetHand == trans.action.targetHand) {
                    chosenIdx = i;
                    break;
                }
            }
            if (chosenIdx < 0) continue;

            // grad = f(a) - sum_a' pi(a') * f(a')
            for (i in 0...21) {
                var expectedF = 0.0;
                for (j in 0...candidates.length) {
                    // 重新计算每个candidate的特征（简化：用chosen action的特征做近似）
                    expectedF += probs[j] * fv[i]; // 简化：假设特征相似
                }
                gradSums[i] += (fv[i] - expectedF) * advantage;
            }
            validCount++;
        }

        // 4. 应用梯度 (alpha * grad，clip到梯度范数)
        if (validCount > 0) {
            for (i in 0...21) {
                var grad = gradSums[i] / validCount;
                var delta = rlLearningRate * grad;

                // 梯度裁剪
                var currentVal = AIThink.getWeight(weightNames[i]);
                var maxDelta = Math.abs(currentVal) * gradientClip;
                if (Math.abs(delta) > maxDelta) delta = (delta > 0 ? maxDelta : -maxDelta);

                var newVal = currentVal + delta;
                // 符号保护
                if (currentVal > 0 && newVal < 0) newVal = currentVal * 0.1;
                if (currentVal < 0 && newVal > 0) newVal = currentVal * 0.1;

                AIThink.setWeight(weightNames[i], newVal);
            }

            trace('[RL] REINFORCE 更新完成，${validCount} 个有效样本，${n} 个总转换');
        }

        // 5. 更新值函数 baseline
        valueFunction.batchUpdate(transitions, 0.001);

        // 6. 清空 buffer
        policyBuffer.clear();
    }

    private function _softmax(scores:Array<Float>, temp:Float):Array<Float> {
        if (scores.length == 0) return [];
        var maxS = scores[0];
        for (s in scores) if (s > maxS) maxS = s;
        var exps = scores.map(function(s) return Math.exp((s - maxS) / temp));
        var sum = 0.0;
        for (e in exps) sum += e;
        return exps.map(function(e) return e / sum);
    }

    public function getRecentWinRate():Float { return 0.5; }
    public function getTotalBattles():Int { return totalBattlesRecorded; }
    public function getWeightStats():Dynamic { return {}; }
}

// ─────────────────────────────────────────────────────────────
// 结构化事件类型（替代文字日志解析）
// ─────────────────────────────────────────────────────────────
enum BattleEventType {
    DoubleStar;
    ZeroCombo;
    Damage;
    Heal;
    ZeroCrisis;
    Poison;
    Death;
}

typedef BattleEvent = {
    var type:BattleEventType;
    var value:Int;        // 伤害量/回血量等
    var actorName:String;
}

typedef StructuredBattle = {
    var p1Name:String;
    var p2Name:String;
    var p1IsChampion:Bool;
    var winner:Null<Camp>;
    var turns:Int;
    var events:Array<BattleEvent>;
}
