// ════════════════════════════════════════════════════════
//  game2-online.js  联机协调层（角色级控制权 4-slot 版）
// ════════════════════════════════════════════════════════

var ONLINE = {
    active:    false,
    slotIdx:   -1,                   // 0~3，我是哪个 slot
    charControl: [0, 1, 0, 1],       // charControl[i] = 控制第 i 个角色的 slotIdx，或 'AI'
    waitingRemoteHelpTank: false,
    _authorityActionId: null,
    _runningHostRequest: false,

    // 房主权威：所有会改变战斗状态的动作只由房主执行；非房主只发请求。
    authoritativeTypes: {
        attack: true, invokeAction: true, wukong02: true, toggleTank: true, delegate: true,
        helpTank: true, steal: true, cake: true, crowCurse: true
    },

    isHost: function() {
        var hostSlot = (NET && NET.roomState && typeof NET.roomState.hostSlot === 'number') ? NET.roomState.hostSlot : 0;
        return ONLINE.slotIdx === hostSlot;
    },

    // 当前是否轮到我操作（基于 charControl）
    isMyTurn: function() {
        if (!ONLINE.active || !Main.turnManager) return true;
        var actorIdx = Main.turnManager.currentPlayerIdx;
        return ONLINE.charControl[actorIdx] === ONLINE.slotIdx;
    },

    // 是否由 AI 控制
    isAIControlled: function(playerIdx) {
        return ONLINE.charControl[playerIdx] === 'AI';
    },

    // 是否应该路由到房主执行
    shouldRouteToHost: function(payload) {
        if (!ONLINE.active || !payload) return false;
        if (!ONLINE.authoritativeTypes[payload.type]) return false;
        return !ONLINE.isHost();
    },

    // 发送操作：战斗动作非房主发请求；房主执行后广播。大厅配置仍直接广播。
    sendAction: function(payload) {
        if (!ONLINE.active) return null;
        var actionId = ONLINE._authorityActionId || (payload && payload._actionId) || null;
        if (ONLINE.shouldRouteToHost(payload)) {
            if (typeof setHint2 === 'function') setHint2('⏳ 已发送操作，等待房主确认...');
            return NET.requestAction(payload, { actionId: actionId });
        }
        return NET.sendAction(payload, { actionId: actionId });
    },

    // 设置某角色的控制方（房主调用）
    setControl: function(playerIdx, controller) {
        ONLINE.charControl[playerIdx] = controller;
    },

    // 接管掉线的 slot：把 charControl 里所有 ==leftSlot 的位置改成 'AI'
    handleSlotLeft: function(leftSlot) {
        for (var i = 0; i < 4; i++) {
            if (ONLINE.charControl[i] === leftSlot) {
                ONLINE.charControl[i] = 'AI';
            }
        }
        if (window.AI) AI.refreshControlled();
        if (typeof updateDelegateButtons === 'function') updateDelegateButtons();
    },

    // 我是否控制了 camp 阵营至少一个角色（HERO=0,2 / REBEL=1,3）
    iControlAnyOf: function(camp) {
        var indices = camp === 'hero' ? [0, 2] : [1, 3];
        for (var k = 0; k < indices.length; k++) {
            if (ONLINE.charControl[indices[k]] === ONLINE.slotIdx) return true;
        }
        return false;
    },

    // 兼容旧接口：返回我"主要"控制的阵营（用于抗伤位切换、render等粗粒度判断）
    myCamp: function() {
        // 如果我控制了HERO的任一角色就返回hero，否则rebel
        if (ONLINE.iControlAnyOf('hero')) return 'hero';
        return 'rebel';
    },
};

ONLINE.applyAction = function(payload, fromRemote) {
    if (!payload || !payload.type) return;
    switch (payload.type) {
        case 'charConfig':
            ONLINE.active      = true;
            ONLINE.charControl = payload.charControl.slice();
            if (payload.aiCharModel && window.AI_CHAR_MODEL) {
                payload.aiCharModel.forEach(function(m, i) {
                    AI_CHAR_MODEL[i] = m;
                    if (window.AI_MODEL_CONFIG) AI_MODEL_CONFIG['p' + i] = m;
                    var mSel = document.getElementById('aiModel' + i);
                    if (mSel) { mSel.value = m; if (typeof updateAiModelVisibility === 'function') updateAiModelVisibility(i); }
                });
            }
            startOnlineGame(payload.charIds[0], payload.charIds[1], payload.charIds[2], payload.charIds[3]);
            break;

        case 'attack':
            doAttack2(payload.actorIdx, payload.myHand, payload.touchTargetIdx, payload.touchHandIdx, payload.dmgTargetIdx, !!fromRemote);
            break;

        case 'wukong02':
            G.wukongPending = payload.wukongPending;
            executeWukong02(payload.chosenTargetIdx, !!fromRemote);
            break;

        case 'toggleTank':
            toggleTank(payload.playerIdx, !!fromRemote);
            break;

        case 'delegate':
            if (typeof applyDelegateLocal === 'function') {
                applyDelegateLocal(payload.playerIdx, !!payload.delegate, payload.controller);
            }
            break;

        case 'helpTank':
            if (!fromRemote && ONLINE.active) ONLINE.sendAction(payload);
            ONLINE.waitingRemoteHelpTank = false;
            G.inputLocked = false;
            if (payload.choice === 'confirm') Main.engine.resolveHelpTank(payload.helperIdx);
            render2(); refreshHandStyles2(); finishTurn2();
            break;

        case 'invokeAction':
            invokeAction2(payload.actorIdx, payload.actionName, payload.params || {}, !!fromRemote, { silent: true });
            break;

        // 兼容旧版消息：之后主动技能都统一走 invokeAction。
        case 'cake':
            invokeAction2(payload.actorIdx, 'useCake', {
                targetIdx: payload.targetIdx,
                groupCount: payload.groupCount || payload.groups || 1
            }, !!fromRemote, { silent: true });
            break;

        case 'crowCurse':
            invokeAction2(payload.actorIdx, 'crowCurseTarget', { camp: payload.camp || 'enemy' }, !!fromRemote, { silent: true });
            break;

        case 'steal':
            if (payload.choice === 'confirm') {
                invokeAction2(payload.daQiaoIdx, 'doSteal', { healerIdx: payload.healerIdx, netHeal: payload.netHeal }, !!fromRemote, { silent: true });
            }
            break;
    }
    if (window.AI && AI.scheduleCheck) AI.scheduleCheck('onlineAction:' + payload.type, 260);
};

ONLINE.runHostRequest = function(payload, fromSlot, actionId) {
    if (!ONLINE.isHost()) return;
    ONLINE._runningHostRequest = true;
    ONLINE._authorityActionId = actionId || (payload && payload._actionId) || null;
    try {
        ONLINE.applyAction(payload, false);
    } finally {
        ONLINE._authorityActionId = null;
        ONLINE._runningHostRequest = false;
    }
};

// ── 远端消息处理 ──
NET.onRemoteAction = function(payload, fromSlot, seq, actionId) {
    ONLINE.applyAction(payload, true);
};

NET.onActionRequest = function(payload, fromSlot, actionId) {
    ONLINE.runHostRequest(payload, fromSlot, actionId);
};

NET.onActionAck = function(msg) {
    if (window.console && msg && msg.duplicate) console.warn('[NET] duplicate action ignored:', msg.actionId);
};

NET.onHostChanged = function(hostSlot) {
    if (ONLINE.active) {
        setHint2('👑 房主已切换到 Slot' + (hostSlot + 1));
        if (window.AI && AI.scheduleCheck) AI.scheduleCheck('hostChanged', 300, true);
    }
};

// 非房主点击“开始游戏”时，服务端把请求转给房主；房主统一生成 charConfig 并开局。
NET.onStartRequest = function(fromSlot) {
    if (!ONLINE.isHost()) return;
    if (ONLINE.active) return;
    var name = (NET.roomState && NET.roomState.slotNames && NET.roomState.slotNames[fromSlot]) || ('Slot' + (fromSlot + 1));
    setOnlineStatus('收到 ' + name + ' 的开始请求，房主正在同步开局...');
    setTimeout(function() {
        if (!ONLINE.active && typeof startGame2 === 'function') startGame2();
    }, 0);
};

// 房间状态变化（有人加入/离开）
NET.onRoomState = function(state) {
    // 注意：游戏中普通 roomState 不能强行恢复 runtimeCharControl，
    // 否则 slotLeft 刚把掉线角色改成 AI 后，又会被旧快照覆盖。
    // 控制权恢复只在 rejoined / slotRejoined 两类明确事件中执行。
    if (window.renderRoomLobby) window.renderRoomLobby(state);
};

NET.onRoomCreated = function(code) {
    ONLINE.slotIdx = NET.slotIdx;
    document.getElementById('roomCodeDisplay').textContent = code;
    var area = document.getElementById('roomCodeArea');
    if (area) area.style.display = 'block';
    setOnlineStatus('房间已创建（你是房主）。等待其他玩家加入...');
    if (document.getElementById('lobbyArea')) {
        document.getElementById('lobbyArea').style.display = 'block';
    }
};

NET.onRoomJoined = function(code) {
    ONLINE.slotIdx = NET.slotIdx;
    setOnlineStatus('已加入房间 ' + code + '，等待房主配置并开始...');
    if (document.getElementById('lobbyArea')) {
        document.getElementById('lobbyArea').style.display = 'block';
    }
    var joinArea = document.getElementById('onlineJoinArea');
    if (joinArea) joinArea.style.display = 'none';
};

NET.onDisconnect = function() {
    if (ONLINE.active) {
        setOnlineStatus('⚠️ 与服务器断开，正在自动重连...');
        if (typeof setHint2 === 'function') setHint2('⚠️ 与服务器断开，正在自动重连...');
    }
};

NET.onRejoined = function(msg) {
    ONLINE.slotIdx = NET.slotIdx;
    if (msg && msg.runtimeCharControl) {
        ONLINE.charControl = msg.runtimeCharControl.slice();
    }
    setOnlineStatus('✅ 已重连到房间 ' + NET.roomCode + '（Slot' + (NET.slotIdx + 1) + '）');
    if (typeof setHint2 === 'function') setHint2('✅ 已重连，可以继续操作');
    if (window.AI) AI.refreshControlled();
    if (typeof updateDelegateButtons === 'function') updateDelegateButtons();
    if (typeof updateTankButtons === 'function') updateTankButtons();
    if (typeof refreshHandStyles2 === 'function') refreshHandStyles2();
    if (window.AI && AI.scheduleCheck) AI.scheduleCheck('rejoined', 500, true);
};

NET.onSlotRejoined = function(slotIdx, charControl) {
    if (!ONLINE.active) return;
    if (charControl) ONLINE.charControl = charControl.slice();
    var name = (NET.roomState && NET.roomState.slotNames && NET.roomState.slotNames[slotIdx]) || ('Slot' + (slotIdx + 1));
    setHint2('✅ ' + name + ' 已重连');
    if (window.AI) AI.refreshControlled();
    if (typeof updateDelegateButtons === 'function') updateDelegateButtons();
    if (typeof updateTankButtons === 'function') updateTankButtons();
    if (typeof refreshHandStyles2 === 'function') refreshHandStyles2();
};

NET.onSlotLeft = function(slotIdx) {
    if (!ONLINE.active) return;
    var name = (NET.roomState && NET.roomState.slotNames && NET.roomState.slotNames[slotIdx]) || ('Slot' + slotIdx);
    setHint2('⚠️ ' + name + ' 已离线，其控制的角色由 AI 接管');
    ONLINE.handleSlotLeft(slotIdx);
    // 角色刚被 AI 接管，如果当前就是该角色的回合，立即让 AI 行动
    if (window.AI && AI.scheduleCheck) AI.scheduleCheck('slotLeft', 600, true);
};

NET.onError = function(msg) {
    setOnlineStatus('❌ ' + msg);
};

// ── 工具 ──
function setOnlineStatus(msg) {
    var el = document.getElementById('onlineStatus');
    if (el) el.textContent = msg;
}

// ── 控制台联机健康检查：netHealth2() ──
function netHealth2() {
    var players = (window.Main && Main.turnManager && Main.turnManager.players) || [];
    var simpleState = [];
    for (var i = 0; i < players.length; i++) {
        var p = players[i];
        if (!p) continue;
        simpleState.push({ idx:i, name:p.name, hp:p.hp, hands:[p.hands[0], p.hands[1]] });
    }
    return {
        online: !!(window.NET && NET.isOnline),
        active: !!(window.ONLINE && ONLINE.active),
        slotIdx: window.NET ? NET.slotIdx : -1,
        roomCode: window.NET ? NET.roomCode : '',
        hostSlot: window.NET && NET.roomState ? NET.roomState.hostSlot : null,
        isHost: !!(window.ONLINE && ONLINE.isHost && ONLINE.isHost()),
        lastSeq: window.NET ? NET.lastSeq : 0,
        charControl: window.ONLINE ? ONLINE.charControl.slice() : null,
        waitingRemoteHelpTank: !!(window.ONLINE && ONLINE.waitingRemoteHelpTank),
        inputLocked: !!(window.G && G.inputLocked),
        turn: window.Main && Main.turnManager ? Main.turnManager.currentPlayerIdx : null,
        players: simpleState
    };
}
window.netHealth2 = netHealth2;
