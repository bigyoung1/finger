// ════════════════════════════════════════════════════════
//  game2-core.js  两步点击状态机 + 攻击 + 回合推进
// ════════════════════════════════════════════════════════

function onHandClick2(playerIdx, handIdx) {
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    if (ONLINE.waitingRemoteHelpTank) { flashHint2("⏳ 等待对方决定是否帮抗..."); return; }
    if (ONLINE.active && !ONLINE.isMyTurn()) { flashHint2("⏳ 等待对方操作..."); return; }
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

        // ── 角色攻击前弹窗钩子（如孙悟空[0,2]选目标）
        if (typeof actor.interceptAttackForDialog === 'function' &&
            actor.interceptAttackForDialog(myHand, intendedTarget, handIdx)) {
            // 角色自己处理弹窗，这里只负责暂存 pending 状态供弹窗回调用
            G.wukongPending = {
                actorIdx: actorIdx, myHand: myHand,
                clickedTargetIdx: playerIdx, targetHandIdx: handIdx
            };
            G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;
            showWukongTargetDialog(actorIdx);
            return;
        }

        var touchTargetIdx = playerIdx;
        var dmgTargetIdx   = getActualTarget(playerIdx);

        G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;
        doAttack2(actorIdx, myHand, touchTargetIdx, handIdx, dmgTargetIdx);
    }
}

// ── 执行攻击 ──
function doAttack2(actorIdx, myHand, touchTargetIdx, touchHandIdx, dmgTargetIdx, fromRemote) {
    var players       = Main.turnManager.players;
    var actor         = players[actorIdx];
    var touchTarget   = players[touchTargetIdx];
    var dmgTargetIdx2 = (dmgTargetIdx !== undefined) ? dmgTargetIdx : touchTargetIdx;
    var dmgTarget     = players[dmgTargetIdx2];

    if (touchTarget.hands[touchHandIdx] === 0) {
        flashHint2('⚠️ 不能碰数字为0的手'); refreshHandStyles2(); return;
    }

    // 攻击前：注入乌鸦buff extraTriggers（灼燃箭/魔王剑）
    if (actor.useBurningArrow) {
        Main.invokeAction(actorIdx, 'injectCrowTriggers', { targetIdx: dmgTargetIdx2 });
    }

    // 攻击前：快照伤害承受者的防御状态（帮抗时恢复用）
    Main.engine.snapshotHelpTankVictim(dmgTarget);

    // 执行碰手（手指数字变化 + 伤害计算）
    var result = Main.engine.handleTouch(actor, myHand, touchTarget, touchHandIdx, dmgTarget);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        flashHint2(result); refreshHandStyles2(); return;
    }

    // 发送操作给对手
    if (!fromRemote) ONLINE.sendAction({ type: "attack", actorIdx: actorIdx, myHand: myHand, touchTargetIdx: touchTargetIdx, touchHandIdx: touchHandIdx, dmgTargetIdx: dmgTargetIdx2 });

    // 濒死检测（主目标）→ 若弹出帮抗窗则回合暂停
    if (tryHelpTankOrPause(dmgTargetIdx2, fromRemote)) return;

    // 反伤致死检测：攻击者可能被双五/藏师反伤打死，补做帮抗检测
    // 反伤不在 lastTouchDamageLog 里，传入 0 让帮抗惩罚按实际反伤重算
    if (actorIdx !== dmgTargetIdx2 && players[actorIdx].hp <= 0) {
        if (tryHelpTankOrPause(actorIdx, fromRemote, 0)) return;
    }

    finishTurn2();
}

// ── 帮抗濒死检测（doAttack2 / executeWukong02 共用）──
// 返回 true 表示已弹出帮抗窗，调用方应 return（回合暂停，等待玩家选择）
// 返回 false 表示无需帮抗，调用方继续 finishTurn2()
// penaltyOverride: 反伤/毒死时 log 里没有对应伤害，传入实际死亡伤害量（用于判断帮抗者是否扛得住）
// penaltyOverride 为 undefined 时按 lastTouchDamageLog 算（普通攻击路径）
function tryHelpTankOrPause(dmgTargetIdx2, fromRemote, penaltyOverride) {
    var players = Main.turnManager.players;
    var dmgTarget = players[dmgTargetIdx2];
    if (!dmgTarget || dmgTarget.hp > 0) return false;

    // 角色自己决定是否接受帮抗（如大乔有复活甲时自己处理，不走帮抗）
    if (typeof dmgTarget.canReceiveHelpTank === 'function' && !dmgTarget.canReceiveHelpTank()) return false;

    var victimCamp = campOf(dmgTargetIdx2);
    var seats = (victimCamp === 'hero') ? [0, 2] : [1, 3];
    // 计算帮抗惩罚伤害：反伤/毒死时 penaltyOverride=0（帮抗者只要活着就能扛）
    var totalPenalty;
    if (penaltyOverride !== undefined) {
        totalPenalty = penaltyOverride;
    } else {
        var log = Main.engine.lastTouchDamageLog || [];
        totalPenalty = 0;
        for (var j = 0; j < log.length; j++) totalPenalty += Math.ceil(log[j].outputAmount * 1.5);
    }

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

    // 联机：受伤方自己弹窗，攻击方等待
    if (ONLINE.active) {
        var victimCamp = campOf(dmgTargetIdx2);
        if (victimCamp !== ONLINE.myCamp()) {
            // 我是攻击方，对方决定帮抗 — 等待
            ONLINE.waitingRemoteHelpTank = true;
            G.inputLocked = true;
            setHint2("⏳ 等待对方决定是否帮抗...");
            return true;
        }
        // 我是受伤方，我弹窗决定（结果通过 onHelpTankConfirm/Cancel 发送给对方）
    }

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
    if (Main.turnManager.gameOver) {
        render2(); refreshHandStyles2(); updateTankButtons();
        return;
    }

    // nextTurn 内部会结算毒伤/回合末效果，可能有人死亡。
    // 先检测当前存活玩家，nextTurn 后对比，对新死亡者补做帮抗检测。
    var players = Main.turnManager.players;
    var aliveBeforeNext = [];
    for (var i = 0; i < players.length; i++) {
        aliveBeforeNext.push(players[i].hp > 0);
    }

    Main.turnManager.nextTurn();

    // 检测 nextTurn 后新死亡的玩家（毒死、双零等），逐一补做帮抗
    if (!Main.turnManager.gameOver) {
        for (var i = 0; i < players.length; i++) {
            if (aliveBeforeNext[i] && players[i].hp <= 0) {
                // penaltyOverride=0：毒/回合结算无攻击者，帮抗者只要活着就行
                if (tryHelpTankOrPause(i, false, 0)) return;
            }
        }
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
