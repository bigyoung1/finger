// ════════════════════════════════════════════════════════
//  game2-dialogs.js  所有弹窗逻辑
// ════════════════════════════════════════════════════════

// ── 帮抗弹窗 ──
// source: 事件模式时传入来源描述（如"反弹盾"/"中毒"/"张飞模态②第二刀"），主线模式为 null/undefined
// eventRecord: 事件模式时的完整记录 {amount, damageTypeStr, source}，用于展示具体伤害数值
function showHelpTankDialog(helperIdx, victimIdx, source, eventRecord) {
    // 联机：只对控制 helper 的 slot 显示帮抗弹窗
    if (ONLINE.active && ONLINE.charControl[helperIdx] !== ONLINE.slotIdx) return;
    var players = Main.turnManager.players;
    G.helpTankContext = { helperIdx: helperIdx, victimIdx: victimIdx };

    var victim = players[victimIdx];
    var helper = players[helperIdx];

    var dmgLines = [];

    if (source && eventRecord) {
        var sourceLabel = '<span style="color:#fa541c;font-weight:600">[' + source + ']</span> ';
        var typeStr2 = eventRecord.damageTypeStr === 'PHYSICAL' ? '物理' : (eventRecord.damageTypeStr === 'MAGIC' ? '法术' : '真实');
        var penalty2 = Math.ceil(eventRecord.amount * 1.5);
        dmgLines.push(sourceLabel + typeStr2 + ' ' + eventRecord.amount + ' × 1.5 = <b>' + penalty2 + '</b>');
    } else {
        var log = Main.engine.lastTouchDamageLog;
        for (var i = 0; i < log.length; i++) {
            var rec = log[i];
            var typeStr = rec.typeName || getDamageTypeName(rec.type);
            var penalty = Math.ceil(rec.outputAmount * 1.5);
            dmgLines.push(typeStr + ' ' + rec.outputAmount + ' × 1.5 = <b>' + penalty + '</b>');
        }
    }

    var dialog = document.getElementById('helpTankDialog');
    if (!dialog) { G.helpTankContext = null; G.inputLocked = false; finishTurn2(); return; }

    document.getElementById('helpTankMsg').innerHTML =
        '⚠️ <b>' + victim.name + '</b> 即将阵亡！' + (source ? ('（' + source + '）') : '') + '<br>' +
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
            // 联机稳定版：非房主只提交选择，不在本地结算；等待房主广播权威结果。
            if (ONLINE.active && !ONLINE.isHost()) {
                ONLINE.sendAction({ type: "helpTank", choice: "confirm", helperIdx: ctx.helperIdx });
                G.inputLocked = true;
                setHint2('⏳ 已提交帮抗选择，等待房主结算...');
                return;
            }
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
    // 联机稳定版：非房主只提交选择，不在本地推进；等待房主广播权威结果。
    if (ONLINE.active && ctx && !ONLINE.isHost()) {
        ONLINE.sendAction({ type: "helpTank", choice: "cancel", helperIdx: ctx.helperIdx });
        G.inputLocked = true;
        setHint2('⏳ 已放弃帮抗，等待房主结算...');
        return;
    }
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
    var ctx = G.wukongPending;
    if (!ctx) return;

    // 联机稳定版：非房主不本地结算孙悟空[0,2]，只提交选择。
    if (!fromRemote && ONLINE.active && !ONLINE.isHost()) {
        ONLINE.sendAction({ type: "wukong02", wukongPending: ctx, chosenTargetIdx: chosenTargetIdx });
        G.wukongPending = null;
        setHint2('⏳ 已提交孙悟空[0,2]目标，等待房主结算...');
        return;
    }

    G.wukongPending = null;
    var players     = Main.turnManager.players;
    var actor       = players[ctx.actorIdx];
    var touchTarget = players[ctx.clickedTargetIdx];
    var dmgTarget   = players[chosenTargetIdx];

    // 攻击前：快照伤害承受者防御状态（帮抗恢复用）
    Main.engine.snapshotHelpTankVictim(dmgTarget);
    var aliveBeforeWukong = [];
    for (var wi = 0; wi < players.length; wi++) aliveBeforeWukong.push(players[wi] && players[wi].hp > 0);

    var result = Main.engine.handleTouch(actor, ctx.myHand, touchTarget, ctx.targetHandIdx, dmgTarget);
    if (typeof result === 'string' && result.indexOf('错误') === 0) {
        flashHint2(result); refreshHandStyles2(); return;
    }

    if (!fromRemote) ONLINE.sendAction({ type: "wukong02", wukongPending: ctx, chosenTargetIdx: chosenTargetIdx });

    // 濒死检测 → 若弹出帮抗窗则回合暂停。统一扫全场，覆盖反弹/第二目标/附加伤害。
    if (checkAllDeathsForHelpTank(fromRemote, aliveBeforeWukong)) return;

    finishTurn2();
}

// ════════════════════════════════════════════════════════
//  抢血/抢补给弹窗（大乔 + 神偷奶爸）
//  - 多弹窗并列显示，互不覆盖；每个弹窗5秒后自动消失。
//  - 同一回血事件内，大乔弹窗优先级高于神偷奶爸；神偷弹窗必须等同事件的大乔弹窗处理/消失后才能点。
// ════════════════════════════════════════════════════════
window._stealUsedThisTurn = window._stealUsedThisTurn || {};
window._stealPromptSeq = window._stealPromptSeq || 0;
window._naiBaPromptKeys = window._naiBaPromptKeys || {};

function _ensureStealStack(thiefIdx) {
    var card = document.getElementById('card2v_' + thiefIdx);
    if (!card) return null;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

    var stackId = 'stealStack_' + thiefIdx;
    var stack = document.getElementById(stackId);
    if (!stack) {
        stack = document.createElement('div');
        stack.id = stackId;
        stack.className = 'steal-stack';
        stack.style.cssText = [
            'position:absolute',
            'z-index:9999',
            'top:6px',
            'right:6px',
            'display:flex',
            'flex-direction:column',
            'gap:4px',
            'align-items:flex-end',
            'max-width:calc(100% - 12px)',
            'pointer-events:auto'
        ].join(';');
        card.appendChild(stack);
    } else if (stack.parentNode !== card) {
        card.appendChild(stack);
    }
    return stack;
}

function _hasHigherPriorityStealPrompt(eventId, priority) {
    if (!eventId) return false;
    var nodes = document.querySelectorAll('.steal-popup[data-event-id="' + eventId + '"]');
    for (var i = 0; i < nodes.length; i++) {
        var p = parseInt(nodes[i].getAttribute('data-priority') || '99', 10);
        if (p < priority) return true;
    }
    return false;
}

function _removeStealPopup(id, key) {
    var el = document.getElementById(id);
    if (!el) return;
    var timer = el._stealTimer;
    if (timer) clearInterval(timer);
    if (key && window._naiBaPromptKeys) delete window._naiBaPromptKeys[key];
    if (el.parentNode) el.parentNode.removeChild(el);
}

function _showStackedStealPopup(opts) {
    var stack = _ensureStealStack(opts.thiefIdx);
    if (!stack) return;

    window._stealPromptSeq += 1;
    var id = 'stealPopup_' + window._stealPromptSeq;
    var div = document.createElement('div');
    div.id = id;
    div.className = 'steal-popup';
    div.setAttribute('data-event-id', String(opts.eventId || 0));
    div.setAttribute('data-priority', String(opts.priority || 9));
    div.style.cssText = [
        'padding:8px 10px',
        'background:' + (opts.background || '#fff0f6'),
        'border:2px solid ' + (opts.border || '#eb2f96'),
        'border-radius:10px',
        'font-size:12px',
        'box-shadow:0 4px 14px rgba(0,0,0,0.16)',
        'min-width:190px',
        'max-width:260px'
    ].join(';');

    div.innerHTML = [
        '<div style="color:#333;margin-bottom:6px;font-weight:bold;line-height:1.35;">' + opts.desc + '</div>',
        '<div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">',
        '  <button class="steal-confirm" style="background:' + (opts.border || '#eb2f96') + ';color:white;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:12px;">抢夺</button>',
        '  <button class="steal-cancel" style="background:white;color:#555;border:1px solid #d9d9d9;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;">放弃</button>',
        '  <span style="color:#ff4d4f;font-size:12px;"><span class="steal-cd">5</span>s</span>',
        '</div>'
    ].join('');

    stack.appendChild(div);

    var cd = 5;
    div._stealTimer = setInterval(function() {
        cd--;
        var cdEl = div.querySelector('.steal-cd');
        if (cdEl) cdEl.textContent = cd;
        if (cd <= 0) _removeStealPopup(id, opts.key);
    }, 1000);

    div.querySelector('.steal-confirm').onclick = function() {
        if (_hasHigherPriorityStealPrompt(opts.eventId || 0, opts.priority || 9)) {
            if (typeof flashHint2 === 'function') flashHint2('⚠️ 同一回血事件中，大乔抢夺优先，请先处理/等待大乔弹窗。');
            return;
        }
        _removeStealPopup(id, opts.key);
        var r = invokeAction2(opts.thiefIdx, opts.actionName, opts.params || {}, false, { silent: true });
        if (typeof r === 'string' && r.indexOf('错误') === 0 && typeof flashHint2 === 'function') flashHint2(r);
        if (typeof render2 === 'function') render2();
    };
    div.querySelector('.steal-cancel').onclick = function() {
        _removeStealPopup(id, opts.key);
    };
}

// Haxe 调用：大乔监听 RECOVERY 后弹窗
function showStealPrompt(daQiaoIdx, healerIdx, netHeal, eventId) {
    eventId = eventId || 0;
    var key = 'dq:' + daQiaoIdx + ':' + healerIdx;
    if (window._stealUsedThisTurn[key]) return;
    window._stealUsedThisTurn[key] = true;

    if (ONLINE.active) {
        var daQiaoCtrl = ONLINE.charControl[daQiaoIdx];
        if (daQiaoCtrl !== 'AI' && daQiaoCtrl !== ONLINE.slotIdx) return;
        if (daQiaoCtrl === 'AI' && !ONLINE.isHost()) return;
    }

    var players = Main.turnManager.players;
    var daQiao  = players[daQiaoIdx];
    var healer  = players[healerIdx];
    if (!daQiao || !healer) return;
    var steal   = Math.floor(netHeal * 0.5) + (daQiao.isGodForm ? 10 : 0);

    if (window.AI && AI.enabled && AI.controlled && AI.controlled[daQiaoIdx]) {
        if (ONLINE.active && !ONLINE.isHost()) return;
        invokeAction2(daQiaoIdx, 'doSteal', { healerIdx: healerIdx, netHeal: netHeal, eventId: eventId }, false, { silent: true });
        return;
    }

    _showStackedStealPopup({
        thiefIdx: daQiaoIdx,
        actionName: 'doSteal',
        params: { healerIdx: healerIdx, netHeal: netHeal, eventId: eventId },
        eventId: eventId,
        priority: 1,
        background: '#fff0f6',
        border: '#eb2f96',
        desc: '🎯 大乔抢 <b>' + healer.name + '</b> 回复 <b>' + netHeal + '</b>' +
              ' → 得 <b style="color:#eb2f96">' + steal + '</b>' +
              (daQiao.isGodForm ? '<span style="color:#eb2f96;font-size:11px"> +10</span>' : '')
    });
}
window.showStealPrompt = showStealPrompt;

// Haxe 调用：神偷奶爸监听 RECOVERY/SUPPLY 后弹窗
function showNaiBaStealPrompt(naiBaIdx, healerIdx, netHeal, healType, eventId) {
    eventId = eventId || 0;
    healType = healType || 'RECOVERY';
    var key = 'nb:' + naiBaIdx + ':' + healerIdx + ':' + eventId + ':' + healType;
    if (window._naiBaPromptKeys[key]) return;
    window._naiBaPromptKeys[key] = true;

    if (ONLINE.active) {
        var ctrl = ONLINE.charControl[naiBaIdx];
        if (ctrl !== 'AI' && ctrl !== ONLINE.slotIdx) return;
        if (ctrl === 'AI' && !ONLINE.isHost()) return;
    }

    var players = Main.turnManager.players;
    var naiBa = players[naiBaIdx];
    var healer = players[healerIdx];
    if (!naiBa || !healer) return;
    var steal = healType === 'SUPPLY' ? Math.max(0, netHeal - 1) : Math.floor(netHeal * 0.5);
    if (steal <= 0) return;

    var params = { healerIdx: healerIdx, netHeal: netHeal, healType: healType, eventId: eventId };
    if (window.AI && AI.enabled && AI.controlled && AI.controlled[naiBaIdx]) {
        if (ONLINE.active && !ONLINE.isHost()) return;
        invokeAction2(naiBaIdx, 'doNaiBaSteal', params, false, { silent: true });
        return;
    }

    _showStackedStealPopup({
        thiefIdx: naiBaIdx,
        actionName: 'doNaiBaSteal',
        params: params,
        eventId: eventId,
        priority: 2,
        key: key,
        background: '#f6ffed',
        border: '#52c41a',
        desc: '🕵️ 神偷抢 <b>' + healer.name + '</b> ' + (healType === 'SUPPLY' ? '补给' : '回复') +
              ' <b>' + netHeal + '</b> → 得 <b style="color:#389e0d">' + steal + '</b>' +
              (healType === 'SUPPLY' ? '<span style="font-size:11px;color:#389e0d">（留1）</span>' : '<span style="font-size:11px;color:#389e0d">（抢半）</span>')
    });
}
window.showNaiBaStealPrompt = showNaiBaStealPrompt;

// render2 调用：当轮到 playerIdx 行动时，清除对他的冷却
function clearStealCooldownForPlayer(playerIdx) {
    var suffix = ':' + playerIdx;
    for (var k in window._stealUsedThisTurn) {
        if (Object.prototype.hasOwnProperty.call(window._stealUsedThisTurn, k) && k.indexOf(suffix) >= 0) {
            delete window._stealUsedThisTurn[k];
        }
    }
}
window.clearStealCooldownForPlayer = clearStealCooldownForPlayer;

// 神偷奶爸伤害转移目标：用和孙悟空[0,2]同风格的目标选择弹窗；不再使用浏览器 prompt。
function _isNaiBaPlayer(p) {
    return !!p && (p.name === '神偷奶爸' || p.id === 'shentounainai');
}

function _handSum2(p) {
    return (p && p.hands) ? ((p.hands[0] || 0) + (p.hands[1] || 0)) : 0;
}

function _canNaiBaTransferBeforeAttack(naiBaIdx, attackerIdx) {
    var players = (Main && Main.turnManager && Main.turnManager.players) ? Main.turnManager.players : [];
    var naiBa = players[naiBaIdx];
    var attacker = players[attackerIdx];
    if (!_isNaiBaPlayer(naiBa) || !attacker) return false;
    if (naiBa.hp <= 0 || attacker.hp <= 0) return false;
    if (!naiBa.transferMode) return false;
    return _handSum2(naiBa) > _handSum2(attacker);
}

function shouldShowNaiBaTransferDialog(actorIdx, dmgTargetIdx) {
    return _canNaiBaTransferBeforeAttack(dmgTargetIdx, actorIdx);
}
window.shouldShowNaiBaTransferDialog = shouldShowNaiBaTransferDialog;

function _naiBaTransferLabel(idx) {
    if (idx < 0) return '空气';
    var players = (Main && Main.turnManager && Main.turnManager.players) ? Main.turnManager.players : [];
    var p = players[idx];
    return p ? (p.name + ' HP:' + p.hp) : '未知目标';
}

// Haxe 兜底调用：不能弹原生 prompt。若攻击前弹窗没有来得及设置目标，就默认空气，相当于只刷新 x。
function selectNaiBaTransferTarget(naiBaIdx, attackerIdx) {
    return -1;
}
window.selectNaiBaTransferTarget = selectNaiBaTransferTarget;

function showNaiBaTransferTargetDialog(ctx) {
    var players = (Main && Main.turnManager && Main.turnManager.players) ? Main.turnManager.players : [];
    var naiBa = players[ctx.naiBaIdx];
    var attacker = players[ctx.actorIdx];
    var list = document.getElementById('naiBaTransferTargetList');
    if (!list || !naiBa || !attacker) {
        executeNaiBaTransferChoice(-1);
        return;
    }

    G.naiBaTransferPending = ctx;
    list.innerHTML = '';

    var msg = document.getElementById('naiBaTransferTargetMsg');
    if (msg) {
        msg.innerHTML = '<b>' + naiBa.name + '</b> 即将受到 <b>' + attacker.name + '</b> 的物理攻击，选择转移目标：<br>' +
            '<span style="color:#8c8c8c">选空气不会转移伤害，只刷新 x。</span>';
    }

    function addBtn(targetIdx, text, className) {
        var btn = document.createElement('button');
        btn.className = className || 'naiba-transfer-btn';
        btn.textContent = text;
        btn.onclick = function() { executeNaiBaTransferChoice(targetIdx); };
        list.appendChild(btn);
    }

    addBtn(-1, '🌫️ 空气（只刷新 x）', 'naiba-transfer-btn air');
    for (var i = 0; i < players.length; i++) {
        if (!players[i] || players[i].hp <= 0) continue;
        if (i === ctx.actorIdx) continue; // 不能把转移伤害打回攻击者本人
        addBtn(i, '🎯 ' + players[i].name + '  HP:' + players[i].hp, 'naiba-transfer-btn');
    }

    var dlg = document.getElementById('naiBaTransferTargetDialog');
    if (dlg) dlg.style.display = 'flex';
}
window.showNaiBaTransferTargetDialog = showNaiBaTransferTargetDialog;

function executeNaiBaTransferChoice(targetIdx) {
    var dlg = document.getElementById('naiBaTransferTargetDialog');
    if (dlg) dlg.style.display = 'none';

    var ctx = G.naiBaTransferPending;
    G.naiBaTransferPending = null;
    if (!ctx) return;

    // 先写入神偷奶爸的“本次攻击者 -> 转移目标”，再继续原本攻击流程。
    invokeAction2(ctx.naiBaIdx, 'setTransferTarget', {
        attackerIdx: ctx.actorIdx,
        targetIdx: targetIdx
    }, false, { silent: true, noRender: true, noBroadcast: true });

    if (typeof setHint2 === 'function') {
        setHint2('🕵️ 神偷奶爸本次转移目标：' + _naiBaTransferLabel(targetIdx));
    }

    if (ctx.setupOnly) {
        if (typeof render2 === 'function') render2();
        return;
    }

    doAttack2(ctx.actorIdx, ctx.myHand, ctx.touchTargetIdx, ctx.touchHandIdx, ctx.dmgTargetIdx, ctx.fromRemote, true);
}
window.executeNaiBaTransferChoice = executeNaiBaTransferChoice;

function cancelNaiBaTransferChoice() {
    executeNaiBaTransferChoice(-1);
}
window.cancelNaiBaTransferChoice = cancelNaiBaTransferChoice;

function openNaiBaTransferDialog(naiBaIdx) {
    // 手动按钮保留，但也改成同样的选择弹窗：默认给“当前行动者”设置转移目标。
    var actorIdx = Main && Main.turnManager ? Main.turnManager.currentPlayerIdx : -1;
    if (actorIdx < 0) {
        if (typeof flashHint2 === 'function') flashHint2('当前没有行动者，无法设置转移目标');
        return;
    }
    showNaiBaTransferTargetDialog({
        naiBaIdx: naiBaIdx,
        actorIdx: actorIdx,
        myHand: G.myHandIdx,
        touchTargetIdx: actorIdx,
        touchHandIdx: 0,
        dmgTargetIdx: naiBaIdx,
        fromRemote: false,
        setupOnly: true
    });
}
window.openNaiBaTransferDialog = openNaiBaTransferDialog;

// ── 蛋糕弹窗 ──
function openCakeDialog(actorIdx, cakesCount) {
    // 联机：只有本方才能操作蛋糕
    if (ONLINE.active && ONLINE.charControl[actorIdx] !== ONLINE.slotIdx) return;
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
    var r = invokeAction2(G.cakeActorIdx, 'useCake', { targetIdx: targetIdx, groupCount: G.cakeGroups }, false, { silent: true });
    if (typeof r === 'string' && r.indexOf('错误') === 0) {
        if (typeof showCardToast2 === 'function') showCardToast2(G.cakeActorIdx, r, true);
        else if (typeof flashHint2 === 'function') flashHint2(r);
        return;
    }
    closeCakeDialog2();
    render2();
}

// ════════════════════════════════════════════════════════
//  鸦眼乌鸦诅咒：选择阵营弹窗
// ════════════════════════════════════════════════════════
function showCrowCurseDialog(actorIdx) {
    if (ONLINE.active && ONLINE.charControl[actorIdx] !== ONLINE.slotIdx) return;
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
    var r = invokeAction2(actorIdx, 'crowCurseTarget', { camp: camp }, false, { silent: true });
    if (typeof r === 'string' && r.indexOf('错误') === 0) {
        if (typeof showCardToast2 === 'function') showCardToast2(actorIdx, r, true);
        else if (typeof flashHint2 === 'function') flashHint2(r);
        return;
    }
}
