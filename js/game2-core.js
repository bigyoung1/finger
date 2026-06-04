// ════════════════════════════════════════════════════════
//  game2-core.js  两步点击状态机 + 攻击 + 回合推进
// ════════════════════════════════════════════════════════

function onHandClick2(playerIdx, handIdx) {
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    if (G.inputLocked) { flashHint2('⏳ 等待帮抗决定...'); return; }
    var players  = Main.turnManager.players;
    var actorIdx = Main.turnManager.currentPlayerIdx;
    var actor    = players[actorIdx];
    var actorCamp = campOf(actorIdx);
    var clickCamp = campOf(playerIdx);
    var isMine    = (clickCamp === actorCamp);

    if (G.step === 0) {
        if (!isMine)            { flashHint2('⚠️ 请先点击【己方】一只手！'); return; }
        if (playerIdx !== actorIdx) { flashHint2('⚠️ 只能动当前行动者的手！'); return; }

        var fakeTarget = findAnyEnemy(actorIdx);
        if (!fakeTarget) { flashHint2('⚠️ 没有可攻击的敌人！'); return; }

        var valid = !actor.isValidTouch ||
                    actor.isValidTouch(handIdx, fakeTarget, 0) ||
                    actor.isValidTouch(handIdx, fakeTarget, 1);
        if (!valid) { flashHint2('🔒 该手当前不可动'); return; }

        G.myHandIdx   = handIdx;
        G.myPlayerIdx = playerIdx;
        G.step = 1;
        refreshHandStyles2();
        setHint2('✅ 已选' + (handIdx === 0 ? '左手' : '右手') + '，请点击【敌方】一只手发动攻击');

    } else {
        if (isMine && playerIdx === actorIdx) {
            G.myHandIdx = handIdx;
            refreshHandStyles2();
            setHint2('✅ 已选' + (handIdx === 0 ? '左手' : '右手') + '，请点击【敌方】一只手发动攻击');
            return;
        }
        if (isMine) { flashHint2('⚠️ 不能碰队友！'); return; }

        var myHand = G.myHandIdx;
        var intendedTarget = players[playerIdx];

        // ── 孙悟空[0,2]检测
        if (actor.zeroTwoUses !== undefined && actor.zeroTwoUses < 3) {
            var newVal   = (actor.hands[myHand] + intendedTarget.hands[handIdx]) % 10;
            var otherVal = actor.hands[1 - myHand];
            var will02   = (otherVal === 0 && newVal === 2) || (newVal === 0 && otherVal === 2);
            if (will02) {
                // dmgTargetIdx 在孙悟空[0,2]时由弹窗选目标决定，这里不传
                G.wukongPending = {
                    actorIdx: actorIdx, myHand: myHand,
                    clickedTargetIdx: playerIdx, targetHandIdx: handIdx
                };
                G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;
                showWukongTargetDialog(actorIdx);
                return;
            }
        }

        var touchTargetIdx = playerIdx;
        var dmgTargetIdx   = getActualTarget(playerIdx);

        G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;
        doAttack2(actorIdx, myHand, touchTargetIdx, handIdx, dmgTargetIdx);
    }
}

// ── 执行攻击 ──
function doAttack2(actorIdx, myHand, touchTargetIdx, touchHandIdx, dmgTargetIdx) {
    var players       = Main.turnManager.players;
    var actor         = players[actorIdx];
    var touchTarget   = players[touchTargetIdx];
    var dmgTargetIdx2 = (dmgTargetIdx !== undefined) ? dmgTargetIdx : touchTargetIdx;
    var dmgTarget     = players[dmgTargetIdx2];

    if (touchTarget.hands[touchHandIdx] === 0) {
        flashHint2('⚠️ 不能碰数字为0的手'); refreshHandStyles2(); return;
    }

    // 攻击前：快照伤害承受者的防御状态（帮抗时恢复用）
    Main.engine.snapshotHelpTankVictim(dmgTarget);

    // 执行碰手（手指数字变化 + 伤害计算）
    var result = Main.engine.handleTouch(actor, myHand, touchTarget, touchHandIdx, dmgTarget);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        flashHint2(result); refreshHandStyles2(); return;
    }

    // 濒死检测 → 若弹出帮抗窗则回合暂停
    if (tryHelpTankOrPause(dmgTargetIdx2)) return;

    finishTurn2();
}

// ── 帮抗濒死检测（doAttack2 / executeWukong02 共用）──
// 返回 true 表示已弹出帮抗窗，调用方应 return（回合暂停，等待玩家选择）
// 返回 false 表示无需帮抗，调用方继续 finishTurn2()
function tryHelpTankOrPause(dmgTargetIdx2) {
    var players = Main.turnManager.players;
    var dmgTarget = players[dmgTargetIdx2];
    if (!dmgTarget || dmgTarget.hp > 0) return false;

    // 大乔复活甲会在 checkGameOver 里自动处理，跳过帮抗
    var hasPendingRevive = (typeof dmgTarget.hasRevived !== 'undefined' &&
                            dmgTarget.hasRevived === false &&
                            typeof dmgTarget.isGodForm !== 'undefined' &&
                            dmgTarget.isGodForm === false);
    if (hasPendingRevive) return false;

    var victimCamp = campOf(dmgTargetIdx2);
    var seats = (victimCamp === 'hero') ? [0, 2] : [1, 3];
    // 计算帮抗总伤害（用于判断帮抗者是否会被打死）
    var log = Main.engine.lastTouchDamageLog || [];
    var totalPenalty = 0;
    for (var j = 0; j < log.length; j++) totalPenalty += Math.ceil(log[j].outputAmount * 1.5);

    var helperIdx = -1;
    for (var i = 0; i < seats.length; i++) {
        var si = seats[i];
        if (si === dmgTargetIdx2) continue;
        if (!players[si] || players[si].hp <= 0) continue;
        // 帮抗者帮抗后不能也死（粗略估计：总惩罚伤害 < 帮抗者当前HP）
        if (totalPenalty < players[si].hp) helperIdx = si;
        break;
    }
    if (helperIdx < 0) return false;

    // 冻结本次伤害快照（防止后续操作清空 lastTouchDamageLog）
    Main.engine.captureHelpTankDamage();
    G.inputLocked = true;
    showHelpTankDialog(helperIdx, dmgTargetIdx2);
    return true;
}

// ── 回合结束 ──
var _lastTurnCount = 0;
function finishTurn2() {
    var prevTurn = Main.turnManager.turnCount;
    Main.turnManager.checkGameOver();
    if (!Main.turnManager.gameOver) {
        Main.turnManager.nextTurn();
    }
    if (Main.turnManager.turnCount > prevTurn) {
        window._stealUsedThisTurn = {};
    }
    render2();
    refreshHandStyles2();
    updateTankButtons();
    if (!Main.turnManager.gameOver) {
        setHint2('👆 请先点击【己方】一只手，再点击【敌方】一只手发动攻击');
    }
}

function endTurn2() {
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    Main.turnManager.nextTurn();
    render2();
    refreshHandStyles2();
    updateTankButtons();
}

function endGame2() {
    if (!Main.turnManager || Main.turnManager.players.length < 4) return;
    Main.endGameAndDownload();
}
