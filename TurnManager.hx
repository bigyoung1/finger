package;

import model.Player;
import model.Camp;

class TurnManager {
    public var turnCount:Int = 1;
    public var currentPlayerIdx:Int = 0;
    public var gameOver:Bool = false;
    public var winningCamp:Null<Camp> = null;
    public var players:Array<Player> = new Array<Player>();

    public function new() {}

    public function setupGame(allPlayers:Array<Player>) {
        this.players = allPlayers;
        this.currentPlayerIdx = 0;
        this.turnCount = 1;
        this.gameOver = false;
        this.winningCamp = null;
        trace('🎮 游戏初始化成功，当前总计参赛人数：${players.length} 人。');

        // 初始化时对第一个玩家做回合开始检查
        onTurnStart(players[currentPlayerIdx]);
    }

    /**
     * 每次轮到某个玩家行动前调用：
     * 1. 清除上回合的 [x,6] 回血已触发标记，允许本回合再触发一次
     * 2. 如果手上有0，递减 zeroTurns 倒计时
     * 3. zeroTurns 归零 → 标记 forcedZeroHand（强制只能动那只手）
     * 4. 检查是否因对手全为0而需要跳过
     * 返回 true = 可以正常行动，false = 必须跳过本回合
     */
    public function onTurnStart(p:Player):Bool {
        // 【冰冻检测】如果有冰冻Buff → 强制跳过本回合（但其他状态仍正常结算）
        var frozenBuff = p.getBuff("FROZEN");
        if (frozenBuff != null && frozenBuff.layers > 0) {
            frozenBuff.layers--;
            trace('🥶 ${p.name} 被冰冻，本回合跳过行动！冰冻剩余 ${frozenBuff.layers} 回合。');
            return false; // 强制跳过
        }

        // 1. 递减倒计时
        //    如果这轮开始手上还有0，就 -1
        //    如果这轮已经不是0了（被动过了），重置倒计时
        // 询问角色是否跳过本次 zeroTurns 递减（如孙悟空 [0,2] 后标记延寿）
        var skipDecrement = p.shouldSkipZeroTurnsDecrement();
        if (skipDecrement) {
            trace('🐒 ${p.name} 本回合跳过 zeroTurns 递减（[0,2]延寿效果）');
        }

        if (p.hands[0] == 0) {
            if (!skipDecrement && p.zeroTurns0 > 0) p.zeroTurns0--;
        } else {
            p.zeroTurns0 = 0;
        }

        if (p.hands[1] == 0) {
            if (!skipDecrement && p.zeroTurns1 > 0) p.zeroTurns1--;
        } else {
            p.zeroTurns1 = 0;
        }

            // 在 TurnManager.hx -> onTurnStart(p:Player) 中修改：
        // 移除原本强制锁死逻辑，改为弱限制或纯提示日志

        if (p.zeroTurns0 == 0 && p.hands[0] == 0) {
            p.forcedZeroHand = -1; // 🌟 再也不强行锁死左手了！
            trace('⚠️ [寿命告急] ${p.name} 左手 0 寿命已尽！若本回合无法改变该手或触发不消耗寿命的特效，将无法使用右手！');
        } else if (p.zeroTurns1 == 0 && p.hands[1] == 0) {
            p.forcedZeroHand = -1; // 🌟 再也不强行锁死右手了！
            trace('⚠️ [寿命告急] ${p.name} 右手 0 寿命已尽！若本回合无法改变该手或触发不消耗寿命的特效，将无法使用左手！');
        } else {
            p.forcedZeroHand = -1;
        }

        // 3. 检查是否被迫跳过：
        //    条件：对手所有能被碰的手都是0（即对手每只手都是0）
        //    这里实现1v1/多人通用版本：
        //    只要场上存在至少一只可以碰的手（属于敌对阵营且数字!=0），就不跳过
        var canAct = false;
        for (other in players) {
            if (other == p) continue;
            if (other.hp <= 0) continue;
            if (other.camp == p.camp) continue; // 友方不能碰（后续2v2扩展时用）
            for (h in other.hands) {
                if (h != 0) {
                    canAct = true;
                    break;
                }
            }
            if (canAct) break;
        }

        if (!canAct) {
            trace('⏭️ [跳过] ${p.name} 的所有对手双手全为0，无法触碰，强制跳过本回合！');
            return false;
        }

        return true;
    }

    /**
     * 行动结束后调用（每次触碰完、前端调用 nextTurn）
     * 1. 结算当前玩家的回合结束Buff（毒伤等）
     * 2. 环形寻找下一个可以行动的玩家
     * 3. 对下一个玩家调用 onTurnStart，如果需要跳过则继续往后找
     */
    public function nextTurn() {
        if (gameOver || players.length == 0) return;

        var current = players[currentPlayerIdx];

        // ── 拦截：双八再动（EXTRA_ACTION）──────────────────────────────
        var extraAction = current.getBuff("EXTRA_ACTION");
        if (extraAction != null && extraAction.layers > 0) {
            extraAction.layers--;
            trace('⚡【双八判定】${current.name} 触发连击！这依然是他的回合！');
            checkGameOver();
            return;
        }

        // ── 回合结束结算：毒伤、Buff流逝、护盾衰减 ──────────────────────
        trace('⏳ [${current.name}] 行动结束，结算回合结束效果...');
        
        // 毒伤等回合结束Buff的扣血由 Player.onTurnEnd() 内的 PoisonBuff.onTurnEnd 自动处理
        current.onTurnEnd();

        // 检查毒伤是否把自己毒死
        checkGameOver();
        if (gameOver) return;

        // ── 环形寻找下一个可行动的玩家 ──────────────────────────────────
        var searchCount = 0;
        var foundNext = false;
        var prevPlayerIdx = currentPlayerIdx;

        while (!foundNext && searchCount < players.length) {
            currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
            searchCount++;

            // 【大回合检测】只要 currentPlayerIdx 绕回到 0，即为一个新大回合
            // 不依赖 prevPlayerIdx == players.length-1，兼容死亡跳过场景
            if (currentPlayerIdx == 0) {
                turnCount++;
                trace('🔄 [大回合结束] 进入第 ${turnCount} 回合，触发全场大回合结束事件。');
                for (p in players) {
                    if (p.hp > 0) p.onBigRoundEnd();
                }
                Main.snapshotState();
            }

            var next = players[currentPlayerIdx];

            // 死人跳过
            if (next.hp <= 0) continue;

            // 【清除上个玩家的 HEALING_TRIGGERED Buff】允许下个玩家的 [x,6] 重新触发
            var healingBuff = next.getBuff("HEALING_TRIGGERED");
            if (healingBuff != null) {
                healingBuff.layers = 0; // 清除
            }

            // 对该玩家做回合开始检查
            var canAct = onTurnStart(next);

            if (!canAct) {
                // 跳过：但仍要结算他的回合结束（让护盾/Buff正常衰减）
                next.onTurnEnd();
                checkGameOver();
                if (gameOver) return;
                continue; // 继续找下一个人
            }

            // 找到了！
            foundNext = true;
            trace('⚔️ [行动切换] 第 ${turnCount} 回合，轮到 [${next.camp}] 的 [${next.name}] 行动！');
            // 广播：某玩家开始行动（大乔用此重置对该玩家的抢夺冷却）
            for (p in players) {
                if (p.hp > 0) p.onAnyTurnStart(next, GameEngine.instance);
            }
            if (next.forcedZeroHand != -1) {
                var handName = (next.forcedZeroHand == 0) ? "左手" : "右手";
                trace('🔒 [限制] ${next.name} 本回合只能动【${handName}】！');
            }
        }

        checkGameOver();
    }

    /**
     * 多人阵营终局判定
     */
    public function checkGameOver() {
        if (gameOver) return;

        // 复活检查：给HP≤0的玩家一次复活机会（如大乔复活甲）
        for (p in players) {
            if (p.hp <= 0) {
                var revived = p.tryRevive(GameEngine.instance);
                if (revived) {
                    trace('✨✨ ${p.name} 触发复活/假死机制，逃过一死！');
                }
            }
        }

        var aliveCamps = new Map<Camp, Bool>();
        var totalAlive = 0;

        for (p in players) {
            if (p.hp > 0) {
                aliveCamps.set(p.camp, true);
                totalAlive++;
            }
        }

        var remainingCamps = [];
        for (camp in aliveCamps.keys()) remainingCamps.push(camp);

        if (remainingCamps.length == 1) {
            gameOver = true;
            winningCamp = remainingCamps[0];
            trace('🏆🏆🏆【游戏结束】最终获胜阵营：${winningCamp}！');
        } else if (totalAlive == 0) {
            gameOver = true;
            winningCamp = null;
            trace('💀💀💀【游戏结束】全场平局！');
        }
    }
}
