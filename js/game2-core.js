// ════════════════════════════════════════════════════════
//  game2-core.js  两步点击状态机 + 攻击 + 回合推进
// ════════════════════════════════════════════════════════

// ── 统一角色主动技能入口 ──
// 任何不属于“普通碰手攻击”的角色主动技能，都走这里：
// 本地执行 Main.invokeAction；联机时广播给其他客户端；远端重放时不再二次广播。
function invokeAction2(actorIdx, actionName, params, fromRemote, options) {
    params = params || {};
    options = options || {};

    if (typeof Main === 'undefined' || !Main.invokeAction) {
        var missing = '错误：Main.invokeAction 未就绪';
        if (!options.silent && typeof showCardToast2 === 'function') showCardToast2(actorIdx, missing, true);
        else if (!options.silent && typeof flashHint2 === 'function') flashHint2(missing);
        return missing;
    }

    // 联机稳定版：非房主不直接改本地状态，只把请求交给房主执行并广播。
    if (!fromRemote && typeof ONLINE !== 'undefined' && ONLINE.active && !ONLINE.isHost()) {
        ONLINE.sendAction({
            type: 'invokeAction',
            actorIdx: actorIdx,
            actionName: actionName,
            params: params
        });
        return '已发送操作请求';
    }

    var result = Main.invokeAction(actorIdx, actionName, params);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        if (!options.silent && typeof showCardToast2 === 'function') showCardToast2(actorIdx, result, true);
        else if (!options.silent && typeof flashHint2 === 'function') flashHint2(result);
        return result;
    }

    if (!fromRemote && !options.noBroadcast && typeof ONLINE !== 'undefined' && ONLINE.active) {
        ONLINE.sendAction({
            type: 'invokeAction',
            actorIdx: actorIdx,
            actionName: actionName,
            params: params
        });
    }

    if (!options.noRender) {
        if (typeof render2 === 'function') render2();
        if (typeof refreshHandStyles2 === 'function') refreshHandStyles2();
    }
    return result;
}
window.invokeAction2 = invokeAction2;

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

    // 联机稳定版：非房主不在本地计算攻击，只把意图发给房主。
    if (!fromRemote && typeof ONLINE !== 'undefined' && ONLINE.active && !ONLINE.isHost()) {
        ONLINE.sendAction({
            type: 'attack',
            actorIdx: actorIdx,
            myHand: myHand,
            touchTargetIdx: touchTargetIdx,
            touchHandIdx: touchHandIdx,
            dmgTargetIdx: dmgTargetIdx2
        });
        refreshHandStyles2();
        return;
    }

    // 攻击前：注入乌鸦buff extraTriggers（灼燃箭/魔王剑）
    if (actor.useBurningArrow) {
        invokeAction2(actorIdx, 'injectCrowTriggers', { targetIdx: dmgTargetIdx2 }, false, { silent: true, noRender: true, noBroadcast: true });
    }

    // 攻击前：快照伤害承受者的防御状态（帮抗时恢复用）
    Main.engine.snapshotHelpTankVictim(dmgTarget);

    // 攻击前：记录所有"还活着"的角色（攻击后只对从活变死的角色做帮抗检测，避免对已经死透的反复弹窗）
    var aliveBefore = [];
    for (var ai = 0; ai < players.length; ai++) {
        aliveBefore.push(players[ai] && players[ai].hp > 0);
    }

    // 执行碰手（手指数字变化 + 伤害计算）
    var result = Main.engine.handleTouch(actor, myHand, touchTarget, touchHandIdx, dmgTarget);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        flashHint2(result); refreshHandStyles2(); return;
    }

    // 发送操作给对手
    if (!fromRemote) ONLINE.sendAction({ type: "attack", actorIdx: actorIdx, myHand: myHand, touchTargetIdx: touchTargetIdx, touchHandIdx: touchHandIdx, dmgTargetIdx: dmgTargetIdx2 });

    // 濒死检测：只看"本次攻击前还活着、攻击后死了"的角色（避免每回合重复对已死透的角色弹窗）
    if (checkAllDeathsForHelpTank(fromRemote, aliveBefore)) return;

    finishTurn2();
}

// ── 帮抗濒死检测：遍历全场，谁死了就检测谁 ──
// 覆盖：主线攻击死亡(lastTouchDamageLog) + 事件模式死亡(反弹/毒伤/模态②第二刀，走 pendingHelpTankEvents)
// 返回 true 表示已弹出帮抗窗（或在等待远端决定），调用方应 return
function checkAllDeathsForHelpTank(fromRemote, aliveBefore) {
    var players = Main.turnManager.players;
    for (var idx = 0; idx < players.length; idx++) {
        var p = players[idx];
        if (!p || p.hp > 0) continue; // 还活着，不处理
        // 关键修复：只处理"本次攻击前还活着、攻击后死了"的角色，
        // 避免对已经死透多回合的角色重复弹"濒死帮抗"窗口
        if (aliveBefore && !aliveBefore[idx]) continue;
        if (typeof p.canReceiveHelpTank === 'function' && !p.canReceiveHelpTank()) continue;

        // 先看是否有事件模式记录（反弹/毒伤/模态②第二刀）
        var ev = Main.engine.consumeHelpTankEvent(p.name);
        if (ev) {
            if (tryHelpTankOrPause(idx, fromRemote, undefined, ev)) return true;
            continue;
        }
        // 否则走主线 lastTouchDamageLog 检测（普通攻击致死）
        if (tryHelpTankOrPause(idx, fromRemote)) return true;
    }
    return false;
}

// ── 帮抗濒死检测（单个角色）──
// 返回 true 表示已弹出帮抗窗，调用方应 return（回合暂停，等待玩家选择）
// 返回 false 表示无需帮抗，调用方继续后续流程
// penaltyOverride: 显式指定惩罚基数时使用（保留兼容）
// eventRecord: {amount, damageType, damageTypeStr, source, attackerName} —— 事件模式专用，来自 consumeHelpTankEvent
function tryHelpTankOrPause(dmgTargetIdx2, fromRemote, penaltyOverride, eventRecord) {
    var players = Main.turnManager.players;
    var dmgTarget = players[dmgTargetIdx2];
    if (!dmgTarget || dmgTarget.hp > 0) return false;

    // 角色自己决定是否接受帮抗（如大乔有复活甲时自己处理，不走帮抗）
    if (typeof dmgTarget.canReceiveHelpTank === 'function' && !dmgTarget.canReceiveHelpTank()) return false;

    var victimCamp = campOf(dmgTargetIdx2);
    var seats = (victimCamp === 'hero') ? [0, 2] : [1, 3];

    var totalPenalty;
    if (eventRecord) {
        totalPenalty = Math.ceil(eventRecord.amount * 1.5);
    } else if (penaltyOverride !== undefined) {
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

    function captureHelpTankSnapshot2() {
        if (eventRecord) {
            Main.engine.snapshotHelpTankVictimFromEvent(dmgTarget, eventRecord.amount, eventRecord.damageType);
        } else {
            Main.engine.captureHelpTankDamage();
        }
    }

    // 联机：由控制 helper 的 slot 来决定。AI 控制的帮抗由房主自动决策并广播，避免所有客户端一起等待一个不存在的弹窗。
    if (ONLINE.active) {
        var helperController = ONLINE.charControl[helperIdx];
        if (helperController === 'AI') {
            if (!ONLINE.isHost()) {
                ONLINE.waitingRemoteHelpTank = true;
                G.inputLocked = true;
                setHint2("⏳ 等待房主结算 AI 帮抗...");
                return true;
            }
            captureHelpTankSnapshot2();
            var doHelp = (window.AI && AI.helpTank && AI.helpTank.decide)
                ? AI.helpTank.decide(helperIdx, dmgTargetIdx2, totalPenalty)
                : (totalPenalty < players[helperIdx].hp);
            ONLINE.sendAction({ type: "helpTank", choice: doHelp ? "confirm" : "cancel", helperIdx: helperIdx });
            if (doHelp) Main.engine.resolveHelpTank(helperIdx);
            G.inputLocked = false;
            G.helpTankContext = null;
            ONLINE.waitingRemoteHelpTank = false;
            return false;
        }
        if (helperController !== ONLINE.slotIdx) {
            ONLINE.waitingRemoteHelpTank = true;
            G.inputLocked = true;
            setHint2("⏳ 等待帮抗者决定...");
            return true;
        }
    }

    // 冻结快照：事件模式 vs 主线模式
    captureHelpTankSnapshot2();
    G.inputLocked = true;
    showHelpTankDialog(helperIdx, dmgTargetIdx2, eventRecord ? eventRecord.source : null, eventRecord);
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
    // 优先用事件队列（毒伤等已登记了真实 ×1.5 惩罚基数），查不到才回退到"只要活着就行"
    if (!Main.turnManager.gameOver) {
        for (var i = 0; i < players.length; i++) {
            if (aliveBeforeNext[i] && players[i].hp <= 0) {
                var ev = Main.engine.consumeHelpTankEvent(players[i].name);
                if (ev) {
                    if (tryHelpTankOrPause(i, false, undefined, ev)) return;
                } else {
                    if (tryHelpTankOrPause(i, false, 0)) return;
                }
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
        if (window.AI && AI.scheduleCheck) AI.scheduleCheck('finishTurn', 260);
    }
}

function endTurn2() {
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    Main.turnManager.nextTurn();
    render2();
    refreshHandStyles2();
    updateTankButtons();
    if (window.AI && AI.scheduleCheck) AI.scheduleCheck('endTurn', 260);
}

function endGame2() {
    if (!Main.turnManager || Main.turnManager.players.length < 4) return;
    // AI 复盘（玩家对战 AI 时）
    if (window.AI && AI.enabled && !AI.train.running) {
        const winner    = Main.turnManager.winningCamp;
        const winnerStr = winner ? (winner._hx_name || String(winner)).toUpperCase() : null;
        AI.reflectBattle(winnerStr).then(() => AI.saveAllCharWeights());
    }
    Main.endGameAndDownload();
}
