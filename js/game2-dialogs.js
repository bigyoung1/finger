// ════════════════════════════════════════════════════════
//  game2-dialogs.js  所有弹窗逻辑
// ════════════════════════════════════════════════════════

// ── 帮抗弹窗 ──
function showHelpTankDialog(helperIdx, victimIdx) {
    // 联机：只对控制 helper 的 slot 显示帮抗弹窗
    if (ONLINE.active && ONLINE.charControl[helperIdx] !== ONLINE.slotIdx) return;
    var players = Main.turnManager.players;
    G.helpTankContext = { helperIdx: helperIdx, victimIdx: victimIdx };

    var victim = players[victimIdx];
    var helper = players[helperIdx];
    var log    = Main.engine.lastTouchDamageLog;

    var dmgLines = [];
    var totalPenalty = 0;
    for (var i = 0; i < log.length; i++) {
        var rec = log[i];
        var typeStr = rec.typeName || getDamageTypeName(rec.type);
        var penalty = Math.ceil(rec.outputAmount * 1.5);
        totalPenalty += penalty;
        dmgLines.push(typeStr + ' ' + rec.outputAmount + ' × 1.5 = <b>' + penalty + '</b>');
    }

    var dialog = document.getElementById('helpTankDialog');
    if (!dialog) { G.helpTankContext = null; G.inputLocked = false; finishTurn2(); return; }

    document.getElementById('helpTankMsg').innerHTML =
        '⚠️ <b>' + victim.name + '</b> 即将阵亡！<br>' +
        '<b>' + helper.name + '</b>，要帮忙承受这次伤害吗？<br>' +
        '<div style="margin:8px 0;padding:8px;background:#fff1f0;border-radius:6px;font-size:12px;line-height:1.8">' +
        dmgLines.join('<br>') +
        '</div>' +
        '<span style="color:#888;font-size:12px">帮抗者走自身减伤/护盾，' +
        helper.name + ' 当前 ' + helper.hp + ' HP</span>';

    dialog.style.display = 'flex';

    var cd = 10;
    document.getElementById('helpTankCountdown').textContent = cd;
    clearInterval(G.helpTankTimer);
    G.helpTankTimer = setInterval(function() {
        cd--;
        var el = document.getElementById('helpTankCountdown');
        if (el) el.textContent = cd;
        if (cd <= 0) { clearInterval(G.helpTankTimer); onHelpTankCancel(); }
    }, 1000);
}

function onHelpTankConfirm() {
    clearInterval(G.helpTankTimer);
    var dlg = document.getElementById('helpTankDialog');
    if (dlg) dlg.style.display = 'none';

    var ctx = G.helpTankContext;
    G.helpTankContext = null;

    try {
        if (ctx) {
            // 联机：我是受伤方，通知攻击方
            if (ONLINE.active) ONLINE.sendAction({ type: "helpTank", choice: "confirm", helperIdx: ctx.helperIdx });
            // 全部结算在 Haxe 内完成：恢复 victim + helper 承伤 ×1.5
            Main.engine.resolveHelpTank(ctx.helperIdx);
        }
    } catch (e) {
        if (window.console) console.error('帮抗结算异常：', e);
    } finally {
        // 无论结算是否异常，都必须解锁并推进回合，避免回合卡死/二次行动
        G.inputLocked = false;
        render2();
        refreshHandStyles2();
        finishTurn2();
    }
}

function onHelpTankCancel() {
    clearInterval(G.helpTankTimer);
    var dlg = document.getElementById('helpTankDialog');
    if (dlg) dlg.style.display = 'none';
    var ctx = G.helpTankContext;
    G.helpTankContext = null;
    G.inputLocked = false;
    // 联机：通知攻击方放弃帮抗
    if (ONLINE.active && ctx) ONLINE.sendAction({ type: "helpTank", choice: "cancel", helperIdx: ctx.helperIdx });
    // victim 正常死亡，直接推进回合
    finishTurn2();
}

function getDamageTypeName(type) {
    if (!type) return '未知';
    var s = (typeof type === 'string') ? type : String(type);
    if (s.indexOf('PHYSICAL') >= 0) return '物理';
    if (s.indexOf('MAGIC')    >= 0) return '法术';
    if (s.indexOf('TRUE')     >= 0) return '真实';
    return s;
}


// ════════════════════════════════════════════════════════
//  孙悟空[0,2]选目标弹窗
function showWukongTargetDialog(actorIdx) {
    var players   = Main.turnManager.players;
    var actorCamp = campOf(actorIdx);
    var list = document.getElementById('wukongTargetList');
    list.innerHTML = '';
    var hasAny = false;
    for (var i = 0; i < players.length; i++) {
        if (campOf(i) === actorCamp || players[i].hp <= 0) continue;
        hasAny = true;
        (function(tIdx) {
            var btn = document.createElement('button');
            btn.className = 'wukong-target-btn';
            btn.textContent = '🎯 ' + players[tIdx].name + '  HP:' + players[tIdx].hp;
            btn.onclick = function() {
                document.getElementById('wukongTargetDialog').style.display = 'none';
                executeWukong02(tIdx);
            };
            list.appendChild(btn);
        })(i);
    }
    if (!hasAny) return;
    document.getElementById('wukongTargetDialog').style.display = 'flex';
}

function executeWukong02(chosenTargetIdx, fromRemote) {
    var ctx = G.wukongPending; G.wukongPending = null;
    if (!ctx) return;
    var players     = Main.turnManager.players;
    var actor       = players[ctx.actorIdx];
    var touchTarget = players[ctx.clickedTargetIdx];
    var dmgTarget   = players[chosenTargetIdx];

    // 攻击前：快照伤害承受者防御状态（帮抗恢复用）
    Main.engine.snapshotHelpTankVictim(dmgTarget);

    var result = Main.engine.handleTouch(actor, ctx.myHand, touchTarget, ctx.targetHandIdx, dmgTarget);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        flashHint2(result); refreshHandStyles2(); return;
    }

    if (!fromRemote) ONLINE.sendAction({ type: "wukong02", wukongPending: ctx, chosenTargetIdx: chosenTargetIdx });

    // 濒死检测 → 若弹出帮抗窗则回合暂停
    if (tryHelpTankOrPause(chosenTargetIdx, fromRemote)) return;

    finishTurn2();
}

// ════════════════════════════════════════════════════════
//  大乔抢夺弹窗
//  - JS层用 _stealUsedThisTurn 记录"本轮已处理过的healer"
//  - key = String(healerIdx)，value = true
//  - 每次 render2 检测到行动者切换时，清除该行动者的记录
// ════════════════════════════════════════════════════════
window._stealUsedThisTurn = {};

// 固定的弹窗DOM（不动态创建，避免重复/找不到）
// 大乔抢血弹窗：直接插入大乔卡片内部，position:absolute 相对卡片定位
// 每次显示时移动到正确的卡片里

function _ensureStealOverlay() {
    if (document.getElementById('stealOverlay')) return;
    var div = document.createElement('div');
    div.id = 'stealOverlay';
    div.style.cssText = [
        'display:none',
        'position:absolute',
        'z-index:9999',
        'top:6px',
        'right:6px',
        'padding:8px 12px',
        'background:#fff0f6',
        'border:2px solid #eb2f96',
        'border-radius:10px',
        'font-size:13px',
        'box-shadow:0 4px 16px rgba(235,47,150,0.25)',
        'max-width:calc(100% - 12px)'
    ].join(';');
    div.innerHTML = [
        '<div id="stealDesc" style="color:#333;margin-bottom:6px;font-weight:bold;font-size:12px;"></div>',
        '<div style="display:flex;gap:6px;align-items:center;">',
        '  <button id="stealConfirmBtn" style="background:#eb2f96;color:white;border:none;padding:4px 12px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:12px;">是</button>',
        '  <button id="stealCancelBtn" style="background:white;color:#555;border:1px solid #d9d9d9;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;">否</button>',
        '  <span style="color:#ff4d4f;font-size:12px;"><span id="stealCd">5</span>s</span>',
        '</div>'
    ].join('');
    // 先挂到 body，_positionStealOverlay 会移到正确卡片里
    document.body.appendChild(div);
}

// 把弹窗节点移入大乔所在的卡片（position:absolute 相对卡片）
function _positionStealOverlay(daQiaoIdx) {
    var overlay = document.getElementById('stealOverlay');
    var card    = document.getElementById('card2v_' + daQiaoIdx);
    if (!overlay || !card) return;
    // 确保卡片有 position:relative（CSS 已设置，这里保险起见再加）
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    // 移入卡片
    if (overlay.parentNode !== card) card.appendChild(overlay);
}

// Haxe 调用此函数（全局）
function showStealPrompt(daQiaoIdx, healerIdx, netHeal) {
    // JS层冷却：同一大回合同一healer只弹一次
    var key = String(healerIdx);
    if (window._stealUsedThisTurn[key]) return;
    window._stealUsedThisTurn[key] = true;

    // 联机：大乔不是我方角色时不显示弹窗（对方自己决定）
    if (ONLINE.active && campOf(daQiaoIdx) !== ONLINE.myCamp()) return;

    // AI 自战：自动决策（大乔血量 < 进化门槛或者抢了更好就抢）
    const daQiao = Main.turnManager.players[daQiaoIdx];
    if (window.AI && AI.enabled && AI.controlled && AI.controlled[daQiaoIdx]) {
        // 大乔永远抢——抢血是她的核心机制
        clearInterval(G.stealTimer);
        Main.invokeAction(daQiaoIdx, 'doSteal', { healerIdx: healerIdx, netHeal: netHeal });
        render2();
        return;
    }

    _ensureStealOverlay();
    _doShowSteal(daQiaoIdx, healerIdx, netHeal);
}

function _doShowSteal(daQiaoIdx, healerIdx, netHeal) {
    _ensureStealOverlay();

    var players = Main.turnManager.players;
    var daQiao  = players[daQiaoIdx];
    var healer  = players[healerIdx];
    var steal   = Math.floor(netHeal * 0.5) + (daQiao.isGodForm ? 10 : 0);

    document.getElementById('stealDesc').innerHTML =
        '🎯 抢 <b>' + healer.name + '</b> 回血 <b>' + netHeal + '</b>' +
        ' → 得 <b style="color:#eb2f96">' + steal + '</b>' +
        (daQiao.isGodForm ? '<span style="color:#eb2f96;font-size:11px"> +10</span>' : '');

    _positionStealOverlay(daQiaoIdx);
    var overlay = document.getElementById('stealOverlay');
    overlay.style.display = 'block';

    // 重置按钮（先clone清除旧事件，再重新绑定）
    var oldConfirm = document.getElementById('stealConfirmBtn');
    var oldCancel  = document.getElementById('stealCancelBtn');
    var newConfirm = oldConfirm.cloneNode(true);
    var newCancel  = oldCancel.cloneNode(true);
    oldConfirm.parentNode.replaceChild(newConfirm, oldConfirm);
    oldCancel.parentNode.replaceChild(newCancel, oldCancel);

    // 倒计时
    clearInterval(G.stealTimer);
    var cd = 5;
    document.getElementById('stealCd').textContent = cd;
    G.stealTimer = setInterval(function() {
        cd--;
        var el = document.getElementById('stealCd');
        if (el) el.textContent = cd;
        if (cd <= 0) { _closeStealOverlay(); }
    }, 1000);

    document.getElementById('stealConfirmBtn').onclick = function() {
        clearInterval(G.stealTimer);
        _closeStealOverlay();
        Main.invokeAction(daQiaoIdx, 'doSteal', { healerIdx: healerIdx, netHeal: netHeal });
        if (ONLINE.active) ONLINE.sendAction({ type: 'steal', choice: 'confirm', daQiaoIdx: daQiaoIdx, healerIdx: healerIdx, netHeal: netHeal });
        render2();
    };
    document.getElementById('stealCancelBtn').onclick = function() {
        clearInterval(G.stealTimer);
        _closeStealOverlay();
        if (ONLINE.active) ONLINE.sendAction({ type: 'steal', choice: 'cancel', daQiaoIdx: daQiaoIdx, healerIdx: healerIdx, netHeal: netHeal });
    };
}

function _closeStealOverlay() {
    clearInterval(G.stealTimer);
    var overlay = document.getElementById('stealOverlay');
    if (overlay) overlay.style.display = 'none';

}

// render2 调用：当轮到 playerIdx 行动时，清除对他的冷却
function clearStealCooldownForPlayer(playerIdx) {
    delete window._stealUsedThisTurn[String(playerIdx)];
}

// ── 蛋糕弹窗 ──
function openCakeDialog(actorIdx, cakesCount) {
    // 联机：只有本方才能操作蛋糕
    if (ONLINE.active && campOf(actorIdx) !== ONLINE.myCamp()) return;
    G.cakeActorIdx = actorIdx; G.cakeGroups = 1;
    document.getElementById('cakeGroupCount2').textContent = '1';
    // cakesCount 由 getCustomActions 里直接编入，避免读Haxe字段失败
    var maxG = Math.floor((cakesCount || 0) / 3);
    G.cakeMaxGroups = maxG;
    _updateCakeHint(maxG);

    var list = document.getElementById('cakeTargetList2');
    list.innerHTML = '';
    var ac = campOf(actorIdx);
    Main.turnManager.players.forEach(function(p, i) {
        if (campOf(i) === ac || p.hp <= 0) return;
        var btn = document.createElement('button');
        btn.style.cssText = 'background:#fff1f0;color:#cf1322;border:2px solid #ffa39e;padding:7px 12px;border-radius:5px;cursor:pointer;font-weight:bold;';
        btn.textContent = '🎯 ' + p.name + ' (HP:' + p.hp + ')';
        btn.onclick = (function(tIdx){ return function(){ _castCake(tIdx); }; })(i);
        list.appendChild(btn);
    });
    document.getElementById('cakeDialog2').style.display = 'flex';
}

function closeCakeDialog2() {
    document.getElementById('cakeDialog2').style.display = 'none';
    G.cakeActorIdx = -1;
}

function changeCakeGroups2(delta) {
    var maxG = G.cakeMaxGroups || 1;
    G.cakeGroups = Math.max(1, Math.min(maxG, G.cakeGroups + delta));
    document.getElementById('cakeGroupCount2').textContent = G.cakeGroups;
    _updateCakeHint(maxG);
}

function _updateCakeHint(maxG) {
    var cost = G.cakeGroups * 3;
    document.getElementById('cakeCostHint2').textContent =
        '消耗 ' + cost + ' 蛋糕 → ' + (G.cakeGroups*10) + ' 法伤 + ' + (G.cakeGroups*10) + ' 补给（最多 ' + maxG + ' 组）';
}

function _castCake(targetIdx) {
    var r = Main.invokeAction(G.cakeActorIdx, 'useCake', { targetIdx: targetIdx, groupCount: G.cakeGroups });
    if (typeof r === 'string' && r.indexOf('错误') === 0) { alert(r); return; }
    closeCakeDialog2();
    render2();
}

// ════════════════════════════════════════════════════════
//  鸦眼乌鸦诅咒：选择阵营弹窗
// ════════════════════════════════════════════════════════
function showCrowCurseDialog(actorIdx) {
    if (ONLINE.active && campOf(actorIdx) !== ONLINE.myCamp()) return;
    // 动态创建简单弹窗
    var existing = document.getElementById('crowCurseDialog');
    if (existing) existing.remove();

    var dlg = document.createElement('div');
    dlg.id = 'crowCurseDialog';
    dlg.className = 'overlay';
    dlg.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;z-index:9998;align-items:center;justify-content:center;background:rgba(0,0,0,0.4)';
    dlg.innerHTML = [
        '<div style="background:white;border-radius:12px;padding:20px 28px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3)">',
        '<div style="font-size:16px;font-weight:bold;margin-bottom:16px">🐦 乌鸦诅咒 — 选择目标阵营</div>',
        '<div style="display:flex;gap:12px;justify-content:center">',
        '<button onclick="castCrowCurse('+actorIdx+',\'enemy\')" style="background:#cf1322;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:bold">⚔️ 对方阵营</button>',
        '<button onclick="castCrowCurse('+actorIdx+',\'ally\')" style="background:#1890ff;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:bold">🛡 己方阵营</button>',
        '<button onclick="document.getElementById(\'crowCurseDialog\').remove()" style="background:#8c8c8c;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px">取消</button>',
        '</div></div>'
    ].join('');
    document.body.appendChild(dlg);
}

function castCrowCurse(actorIdx, camp) {
    var dlg = document.getElementById('crowCurseDialog');
    if (dlg) dlg.remove();
    var r = Main.invokeAction(actorIdx, 'crowCurseTarget', { camp: camp });
    if (typeof r === 'string' && r.indexOf('错误') === 0) { alert(r); return; }
    if (ONLINE.active) ONLINE.sendAction({ type: 'crowCurse', actorIdx: actorIdx, camp: camp });
    render2();
}
