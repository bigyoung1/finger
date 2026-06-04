package ai;

import model.Player;
import model.Camp;
import GameEngine;
import TurnManager;
import Main;
import ai.AIThink;
import ai.BattleLearning;
import ai.AIThink.StateCopier;
import ai.AIThink.RLState;
import ai.AIThink.RLAction;
import ai.AIThink.Transition;
import haxe.Timer;

/**
 * AI Battle Runner
 *
 * Functions:
 * 1. Random character selection (exclude Yangdali and blank characters)
 * 2. Two AI battles, using heuristic evaluation to choose actions
 * 3. Record complete game logs
 * 4. After game ends, winner and loser each review
 * 5. Every 5 rounds, pause and ask user whether to continue
 */
class AIBattleRunner {

    public static var instance:AIBattleRunner;

    // Config
    public var autoRestartDelay:Int = 3000; // Delay before auto next round (ms)
    public var roundsBeforePrompt:Int = 50;   // Ask every N rounds

    // State
    private var battleLog:Array<String> = [];
    private var battleHistory:Array<BattleRecord> = new Array<BattleRecord>();
    private var currentRound:Int = 0;
    private var totalBattles:Int = 0;
    private var wins1:Int = 0;
    private var wins2:Int = 0;
    private var draws:Int = 0;
    private var isRunning:Bool = false;
    private var pendingPrompt:Bool = false;

    // Current battle state (for resume)
    private var currentEngine:GameEngine = null;
    private var currentTM:TurnManager = null;
    private var currentRecord:BattleRecord = null;

    // Review related
    private var currentReview:ReviewRecord = null;

    // Learning system
    private var learning:BattleLearning = new BattleLearning();

    public function new() {
        AIBattleRunner.instance = this;
    }

    private function printGameRules():Void {
        trace('');
        trace('╔═══════════════════════════════════════════════════════════════════╗');
        trace('║                    AI 智 能 体 游 戏 指 南                          ║');
        trace('╚═══════════════════════════════════════════════════════════════════╝');
        trace('');
        trace('【核心规则】');
        trace('  · 1v1回合制，每玩家2手，数字0-9');
        trace('  · 触碰：(A手+B手)%10 → 更新我方A手');
        trace('  · 目标：对方HP归零即获胜');
        trace('');
        trace('【数字组合特效】');
        trace('  ★ 双子星：双手相同 → S级伤害');
        trace('    [1,1]无敌2回合 [2,2][3,3]盾30点3回合 [4,4]伤害x2 [5,5]反弹盾');
        trace('    [6,6]回血90 [7,7]30伤+3层毒 [8,8]额外行动2次 [9,9]终极40x2^N伤 [0,0]150真伤');
        trace('');
        trace('  ★ 0组合：一只手变成0 → 另一手决定效果');
        trace('    0+0→150伤  0+1/5/8/9→40伤  0+2/3→20盾  0+4/6→30回血  0+7→10伤+毒');
        trace('');
        trace('  ★ 单手6：手变成6 → 立即回血30点');
        trace('');
        trace('【危险规则】');
        trace('  · 两只手同时变0 → 立即死亡');
        trace('  · 0手有倒计时，到0时强制用0手触碰，否则手被摧毁扣HP');
        trace('');
        trace('【各角色特点】');
        trace('  小乔：回血/物伤x1.5，0可停留3回合');
        trace('  藏师：受伤减半，回血x2.5，可消耗蛋糕造伤+回血');
        trace('  法师：0组合伤害翻倍+45法伤+雷霆之怒');
        trace('  孙悟空：x/y动态增益，[0,2]冻结目标');
        trace('  大乔：抢夺他人50%回血，物伤回50%血');
        trace('  忍者：物伤附加50%法伤+中毒，中毒越多减伤越高');
        trace('  张飞：怒气系统，狂暴后物伤x2.25，回血翻倍');
        trace('');
        trace('═══════════════════════════════════════════════════════════════════');
    }

    // ============================================================
    // External entry points
    // ============================================================

    /**
     * Start an AI battle
     */
    public function startBattle():Void {
        if (isRunning) {
            trace('[AIBattle] Battle in progress, please wait');
            return;
        }

        // AI reads game rules before each battle
        printGameRules();

        // Show previous battle log for pre-review
        if (battleHistory.length > 0) {
            var prev = battleHistory[battleHistory.length - 1];
            trace('');
            trace('╔═══════════════════════════════════════════════════╗');
            trace('║      上一局复盘 Battle #' + prev.battleNumber + '                   ║');
            trace('╚═══════════════════════════════════════════════════╝');
            trace('对阵: ' + prev.player1 + ' VS ' + prev.player2);
            trace('结果: ' + (prev.winner != null ? prev.winner + '阵营获胜' : '平局') + ' (' + prev.totalTurns + '回合)');
            trace('');
            trace('【游戏日志】');
            for (logLine in prev.log) {
                trace(logLine);
            }
            if (prev.review != null) {
                trace('');
                trace('【复盘分析】');
                trace('[胜] ' + prev.review.winner + ':');
                for (a in prev.review.winnerAnalysis) {
                    trace('  * ' + a);
                }
                trace('[败] ' + prev.review.loser + ':');
                for (a in prev.review.loserAnalysis) {
                    trace('  * ' + a);
                }
                trace('关键节点:');
                for (m in prev.review.keyMoments) {
                    trace('  ◆ ' + m);
                }
            }
            trace('');
            trace('───────────────────────────────────────────────────');
        }

        isRunning = true;
        pendingPrompt = false;
        currentRound = 1;
        battleLog = [];
        trace('==================================================');
        trace('[AI Battle] Battle #{${totalBattles + 1} begins!');
        trace('==================================================');

        // Randomly select two different characters
        var char1 = randomCharacter();
        var char2 = randomCharacter();
        while (char2 == char1) char2 = randomCharacter();

        var p1 = character.CharacterRegistry.createCharacter(char1, Camp.HERO);
        var p2 = character.CharacterRegistry.createCharacter(char2, Camp.REBEL);

        setupAndRunBattle(p1, p2);
    }

    /**
     * Stop auto battle
     */
    public function stopBattle():Void {
        isRunning = false;
        pendingPrompt = false;
        currentEngine = null;
        currentTM = null;
        currentRecord = null;
        trace('[AIBattle] Auto battle stopped');
    }

    /**
     * User chooses to continue
     */
    public function continueBattle():Void {
        if (!pendingPrompt) return;
        pendingPrompt = false;
        trace('[AIBattle] Continuing to next round!');
        startBattle();
    }

    /**
     * User chooses to stop
     */
    public function stopAfterPrompt():Void {
        stopBattle();
        printSummary();
    }

    // ============================================================
    // Core flow
    // ============================================================

    private function setupAndRunBattle(p1:Player, p2:Player):Void {
        battleLog = [];

        // Record this battle
        var record:BattleRecord = {
            battleNumber: totalBattles + 1,
            player1: p1.name,
            player2: p2.name,
            winner: null,
            totalTurns: 0,
            log: [],
            review: null
        };

        currentRecord = record;

        // Create game engine and turn manager
        var engine = new GameEngine();
        var tm = new TurnManager();
        engine.setTurnManager(tm);
        currentEngine = engine;
        currentTM = tm;

        // Inject to Main for UI updates
        Main.engine = engine;
        Main.turnManager = tm;

        var allPlayers = [p1, p2];
        tm.setupGame(allPlayers);

        trace('Sword [AI Battle] ${p1.name} (${p1.hp}HP) VS ${p2.name} (${p2.hp}HP)');
        // 通知学习系统：p1 = 冠军（index 0），p2 = 挑战者（index 1）
        learning.onBattleStart(p1.name, p2.name, true);

        // Record initial state
        appendLog('==== Battle Start ====');
        appendLog('P1: ${p1.name} (HP: ${p1.hp}, Camp: ${p1.camp})');
        appendLog('P2: ${p2.name} (HP: ${p2.hp}, Camp: ${p2.camp})');
        appendLog('');

        // Start auto battle loop
        scheduleNextStep();
    }

    private function scheduleNextStep():Void {
        if (!isRunning) return;

        var engine = currentEngine;
        var tm = currentTM;
        var record = currentRecord;

        if (tm == null || engine == null || record == null) {
            isRunning = false;
            return;
        }

        if (tm.gameOver) {
            finishBattle();
            return;
        }

        var currentIdx = tm.currentPlayerIdx;
        var current = tm.players[currentIdx];
        var opponent = tm.players[1 - currentIdx];

        // 冠军用冠军权重，挑战者用挑战者权重（让两套权重真正对抗）
        var aiInstance = (currentIdx == 0) ? learning.getChampion() : learning.getCurrentAI();

        // RL: 记录动作前的状态（用于构建 transition）
        var beforeState = StateCopier.snapshot(engine, currentIdx);
        var prevActorHp = current.hp;
        var prevOppHp = opponent.hp;

        var action = aiInstance.chooseActionWith(current, opponent, engine);

        if (action == null) {
            // No valid action, skip
            trace('[AI Battle] ${current.name} has no valid action, skip turn');
            tm.nextTurn();
            record.totalTurns++;
            Timer.delay(scheduleNextStep, 50);
            return;
        }

        // Execute touch
        var result = engine.handleTouch(current, action.myHand, opponent, action.targetHand);

        // RL: 记录 transition (before state → action → after state → reward)
        var afterState = StateCopier.snapshot(engine, currentIdx);
        var gamma = 0.95;
        // Dense reward: (actor HP change - opponent HP change) / 100, discounted
        var actorHpChange = current.hp - prevActorHp;
        var oppHpChange = opponent.hp - prevOppHp;  // negative if opponent took damage
        var reward = Math.pow(gamma, record.totalTurns) * (actorHpChange - oppHpChange) / 100.0;

        var trans:Transition = {
            before: beforeState,
            action: { myHand: action.myHand, targetHand: action.targetHand },
            after: afterState,
            reward: reward,
            isTerminal: tm.gameOver,
            winner: tm.gameOver ? tm.winningCamp : null,
            turnNum: record.totalTurns,
            actionLogProb: 0.0,
            return_: 0.0,
            advantage: 0.0
        };
        learning.policyBuffer.push(trans);

        appendLog('> ${current.name} used[${current.hands[action.myHand]}] on ${opponent.name}[${opponent.hands[action.targetHand]}] -> ${current.hands[action.myHand]}');
        trace('Sword AI Action: ${current.name} -> ${result}');

        // Record structured events for learning
        var dmgDealt = prevOppHp - opponent.hp;
        if (dmgDealt > 0) {
            learning.recordEvent({ type: Damage, value: dmgDealt, actorName: current.name });
        }
        // Detect zero crisis
        if ((current.hands[0] == 0 && current.zeroTurns0 <= 1) || (current.hands[1] == 0 && current.zeroTurns1 <= 1)) {
            learning.recordEvent({ type: ZeroCrisis, value: 1, actorName: current.name });
        }

        // Check game over
        tm.checkGameOver();
        record.totalTurns++;

        if (tm.gameOver) {
            Timer.delay(finishBattle, 50);
            return;
        }

        // Turn switch
        tm.nextTurn();

        // Schedule next step
        Timer.delay(scheduleNextStep, 50);
    }

    private function finishBattle():Void {
        var engine = currentEngine;
        var tm = currentTM;
        var record = currentRecord;

        if (engine == null || tm == null || record == null) {
            isRunning = false;
            return;
        }

        totalBattles++;
        record.winner = tm.winningCamp;
        // 通知学习系统对局结束（使用结构化数据，不靠解析日志）
        learning.onBattleEnd(tm.winningCamp, record.totalTurns);

        // RL: 执行 REINFORCE 梯度更新
        learning.applyREINFORCE();

        var winner:Player = null;
        var loser:Player = null;

        if (tm.winningCamp == Camp.HERO) {
            winner = tm.players[0];
            loser = tm.players[1];
            wins1++;
        } else if (tm.winningCamp == Camp.REBEL) {
            winner = tm.players[1];
            loser = tm.players[0];
            wins2++;
        } else {
            draws++;
        }

        appendLog('');
        appendLog('==== Battle End ====');
        appendLog('Total turns: ${record.totalTurns}');
        if (winner != null) {
            appendLog('Winner: ${winner.name} (HP remaining: ${winner.hp})');
            appendLog('Loser: ${loser.name} (HP remaining: ${loser.hp})');
        } else {
            appendLog('Result: Draw');
        }

        record.log = battleLog.copy();

        trace('');
        trace('Trophy [AI Battle] Battle #${totalBattles} ended! ${winner != null ? winner.name + " wins!" : "Draw!"}');
        trace('Record: ${wins1}W/${wins2}W/${draws}D | ${learning.getProgress()}');

        // Review
        if (winner != null && loser != null) {
            currentReview = doReview(winner, loser, record, tm);
            record.review = currentReview;
        }

        battleHistory.push(record);

        // Learn from this battle
        learning.recordBattle(
            record.battleNumber,
            record.winner,
            record.player1,
            record.player2,
            record.totalTurns,
            record.log
        );

        // Silent log - just trace confirmation
        var resultStr = record.winner != null ? Std.string(record.winner) : "Draw";
        trace('[AIBattle] Battle #${record.battleNumber} logged (P1:${record.player1} P2:${record.player2} → $resultStr)');

        // Clear current battle state
        currentEngine = null;
        currentTM = null;
        currentRecord = null;

        // Check if need to ask
        isRunning = false;
        if (currentRound >= roundsBeforePrompt) {
            currentRound = 0;
            pendingPrompt = true;
            promptUser();
        } else {
            currentRound++;
            // Auto start next battle
            trace('[AI Battle] Auto next battle in ${autoRestartDelay/1000}s...');
            Timer.delay(startBattle, autoRestartDelay);
        }
    }

    // ============================================================
    // Review
    // ============================================================

    private function doReview(winner:Player, loser:Player, record:BattleRecord, tm:TurnManager):ReviewRecord {
        appendLog('');
        appendLog('==== Review Analysis ====');

        var review:ReviewRecord = {
            winner: winner.name,
            loser: loser.name,
            winnerAnalysis: analyzeWinner(winner, loser, record, tm),
            loserAnalysis: analyzeLoser(winner, loser, record, tm),
            keyMoments: findKeyMoments(record)
        };

        appendLog('[Winner ${winner.name} Analysis]');
        for (line in review.winnerAnalysis) {
            appendLog('  * $line');
            trace('  * $line');
        }

        appendLog('');
        appendLog('[Loser ${loser.name} Analysis]');
        for (line in review.loserAnalysis) {
            appendLog('  * $line');
            trace('  * $line');
        }

        appendLog('');
        appendLog('[Key Moments]');
        for (moment in review.keyMoments) {
            appendLog('  ◆ $moment');
            trace('  ◆ $moment');
        }

        return review;
    }

    private function analyzeWinner(winner:Player, loser:Player, record:BattleRecord, tm:TurnManager):Array<String> {
        var analysis = new Array<String>();

        // HP advantage
        var hpDiff = winner.hp - loser.hp;
        if (hpDiff > 0) {
            analysis.push('HP leads by ${hpDiff}, resource advantage obvious');
        }

        // Combo count
        var doubleStars = countDoubleStars(record.log);
        var zeroCombos = countZeroCombos(record.log);
        if (doubleStars > 0) analysis.push('Triggered $doubleStars Double-Star combos');
        if (zeroCombos > 0) analysis.push('Triggered $zeroCombos Zero combos');

        // Character-specific analysis
        if (winner.name == "XiaoQiao" || winner.name == "xiaoqiao") {
            analysis.push('XiaoQiao heal/damage linkage performed well');
        } else if (winner.name == "ZangShi" || winner.name == "zangshi") {
            var cakes = analyzeCakes(record.log);
            analysis.push('Strawberry Cake system worked well (${cakes} uses)');
        } else if (winner.name == "FaShi" || winner.name == "fashi") {
            analysis.push('Mage Thunder Rage damage stacked well');
        } else if (winner.name == "SunWuKong" || winner.name == "sunwukong") {
            analysis.push('SunWuKong dynamic x/y bonus maximized');
        } else if (winner.name == "RenZhe" || winner.name == "renzhe") {
            analysis.push('Ninja poison-damage-heal loop sustained output');
        } else if (winner.name == "ZhangFei" || winner.name == "zhangfei") {
            analysis.push('ZhangFei Rage system reached Frenzy form');
        }

        // Key decisions
        analysis.push('Overall decisions reasonable, pace control good');

        return analysis;
    }

    private function analyzeLoser(winner:Player, loser:Player, record:BattleRecord, tm:TurnManager):Array<String> {
        var analysis = new Array<String>();

        // HP disadvantage reason
        if (loser.hp <= 0) {
            analysis.push('Killed by ' + winner.name);
        }

        // Zero crisis
        var zeroCrises = countZeroCrises(record.log, loser.name);
        if (zeroCrises > 0) {
            analysis.push('Fell into $zeroCrises Zero countdown crises, decisions restricted');
        }

        // Character-specific analysis
        if (loser.name == "XiaoQiao" || loser.name == "xiaoqiao") {
            analysis.push('XiaoQiao fragile, hard to survive focus fire');
        } else if (loser.name == "ZangShi" || loser.name == "zangshi") {
            analysis.push('ZangShi cake system not effectively accumulated');
        } else if (loser.name == "FaShi" || loser.name == "fashi") {
            analysis.push('Mage HP too low, easy to oneshot');
        } else if (loser.name == "DaQiao" || loser.name == "daqiao") {
            analysis.push('DaQiao steal advantage not utilized in 1v1');
        }

        // Strategy suggestions
        analysis.push('Suggestion: Optimize Zero usage strategy, avoid countdown crisis');
        analysis.push('Suggestion: Trigger more heal/shield combos, maintain resource advantage');

        return analysis;
    }

    private function findKeyMoments(record:BattleRecord):Array<String> {
        var moments = new Array<String>();
        var log = record.log;

        // Find key events
        for (line in log) {
            if (line.indexOf('S') != -1 && (line.indexOf('Double') != -1 || line.indexOf('Trophy') != -1)) {
                moments.push('Key combo: ' + line);
            } else if (line.indexOf('damage') != -1 && line.indexOf('S') != -1) {
                moments.push('Key damage: ' + line);
            } else if (line.indexOf('Winner') != -1) {
                moments.push('Game end: ' + line);
            }
        }

        if (moments.length == 0) {
            moments.push('Battle even, no decisive moment');
        }

        return moments;
    }

    // ============================================================
    // Utility methods
    // ============================================================

    private function randomCharacter():String {
        // Exclude Yangdali and blank characters
        var options = [
            "xiaoqiao", "zangshi", "fashi", "sunwukong",
            "daqiao", "renzhe", "zhangfei"
        ];
        return options[Std.random(options.length)];
    }

    private inline function appendLog(msg:String):Void {
        battleLog.push(msg);
    }

    private function countDoubleStars(log:Array<String>):Int {
        var count = 0;
        for (line in log) {
            if (line.indexOf('Double') != -1 || line.indexOf('double') != -1) {
                count++;
            }
        }
        return count;
    }

    private function countZeroCombos(log:Array<String>):Int {
        var count = 0;
        for (line in log) {
            if (line.indexOf('Zero') != -1 || line.indexOf('zero') != -1) {
                count++;
            }
        }
        return count;
    }

    private function countZeroCrises(log:Array<String>, playerName:String):Int {
        var count = 0;
        for (line in log) {
            if (line.indexOf(playerName) != -1 && line.indexOf('countdown') != -1) {
                count++;
            }
        }
        return count;
    }

    private function analyzeCakes(log:Array<String>):Int {
        var count = 0;
        for (line in log) {
            if (line.indexOf('Cake') != -1 && line.indexOf('consume') != -1) {
                count++;
            }
        }
        return count;
    }

    // ============================================================
    // User interaction
    // ============================================================

    private function promptUser():Void {
        trace('');
        trace('==================================================');
        trace('[AI Battle] Completed $roundsBeforePrompt battles!');
        trace('Total record: ${wins1}W/${wins2}W/${draws}D');
        trace('==================================================');
        trace('Continue battle?');
        trace('  -> Main.continueAIBattle() to continue');
        trace('  -> Main.stopAIBattle() to stop and view summary');
        trace('');

        // Try to show browser confirm dialog
        var window:Dynamic = js.Browser.window;
        var shouldContinue = window.confirm('AI battle completed $roundsBeforePrompt rounds!\nRecord: ${wins1}W/${wins2}W/${draws}D\n\nContinue battle?');
        if (shouldContinue) {
            continueBattle();
        } else {
            stopAfterPrompt();
        }
    }

    private function printSummary():Void {
        trace('');
        trace('==================================================');
        trace('           AI Battle Summary Report');
        trace('==================================================');
        trace('Total battles: ${totalBattles}');
        if (totalBattles > 0) {
            trace('Win rate: P1 ${wins1} (${Std.int(wins1/totalBattles*100)}%) | P2 ${wins2} (${Std.int(wins2/totalBattles*100)}%) | Draw ${draws}');
        }
        trace('');

        if (battleHistory.length > 0) {
            trace('Recent battles:');
            var start = Std.int(Math.max(0, battleHistory.length - 5));
            for (i in start...battleHistory.length) {
                var r = battleHistory[i];
                var result = r.winner != null ? '${r.winner}W' : 'Draw';
                trace('  Battle${r.battleNumber}: ${r.player1} VS ${r.player2} -> $result (${r.totalTurns} turns)');
            }
        }

        trace('==================================================');
        trace('');
        trace('Detailed logs saved to console, use Main.downloadAIBattleLog() to download');
    }

    // ============================================================
    // Log export
    // ============================================================

    public function getBattleHistory():Array<BattleRecord> {
        return battleHistory;
    }

    public function getCurrentLog():Array<String> {
        return battleLog;
    }

    public function getLearning():BattleLearning {
        return learning;
    }

    public function resetLearning():Void {
        learning = new BattleLearning();
        trace('[AIBattle] Learning history reset');
    }
}

/**
 * Single battle record
 */
typedef BattleRecord = {
    var battleNumber:Int;
    var player1:String;
    var player2:String;
    var winner:Null<Camp>;
    var totalTurns:Int;
    var log:Array<String>;
    var review:Null<ReviewRecord>;
}

/**
 * Review record
 */
typedef ReviewRecord = {
    var winner:String;
    var loser:String;
    var winnerAnalysis:Array<String>;
    var loserAnalysis:Array<String>;
    var keyMoments:Array<String>;
}