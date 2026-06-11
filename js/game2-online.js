// ════════════════════════════════════════════════════════
//  game2-online.js  联机协调层（角色级控制权 4-slot 版）
// ════════════════════════════════════════════════════════

var ONLINE = {
    active:    false,
    slotIdx:   -1,                   // 0~3，我是哪个 slot
    charControl: [0, 1, 0, 1],       // charControl[i] = 控制第 i 个角色的 slotIdx，或 'AI'
    waitingRemoteHelpTank: false,

    isHost: function() { return ONLINE.slotIdx === 0; },

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

    // 发送操作
    sendAction: function(payload) {
        if (ONLINE.active) NET.sendAction(payload);
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

// ── 远端消息处理 ──
NET.onRemoteAction = function(payload, fromSlot) {
    switch (payload.type) {
        case 'charConfig':
            // 房主发来的角色与控制配置
            ONLINE.active      = true;
            ONLINE.charControl = payload.charControl.slice();
            startOnlineGame(payload.charIds[0], payload.charIds[1], payload.charIds[2], payload.charIds[3]);
            break;

        case 'attack':
            doAttack2(
                payload.actorIdx, payload.myHand,
                payload.touchTargetIdx, payload.touchHandIdx,
                payload.dmgTargetIdx,
                true
            );
            break;

        case 'wukong02':
            G.wukongPending = payload.wukongPending;
            executeWukong02(payload.chosenTargetIdx, true);
            break;

        case 'toggleTank':
            toggleTank(payload.playerIdx, true);
            break;

        case 'helpTank':
            ONLINE.waitingRemoteHelpTank = false;
            G.inputLocked = false;
            if (payload.choice === 'confirm') {
                Main.engine.resolveHelpTank(payload.helperIdx);
            }
            render2(); refreshHandStyles2(); finishTurn2();
            break;

        case 'cake':
            Main.invokeAction(payload.actorIdx, 'useCake', { target: payload.targetIdx, groups: payload.groups });
            render2(); refreshHandStyles2(); finishTurn2();
            break;

        case 'steal':
            if (payload.choice === 'confirm') {
                Main.invokeAction(payload.daQiaoIdx, 'doSteal', { healerIdx: payload.healerIdx, netHeal: payload.netHeal });
                render2();
            }
            break;
    }
};

// 房间状态变化（有人加入/离开）
NET.onRoomState = function(state) {
    if (window.renderRoomLobby) window.renderRoomLobby(state);
};

NET.onRoomCreated = function(code) {
    document.getElementById('roomCodeDisplay').textContent = code;
    var area = document.getElementById('roomCodeArea');
    if (area) area.style.display = 'block';
    setOnlineStatus('房间已创建（你是房主）。等待其他玩家加入...');
    if (document.getElementById('lobbyArea')) {
        document.getElementById('lobbyArea').style.display = 'block';
    }
};

NET.onRoomJoined = function(code) {
    setOnlineStatus('已加入房间 ' + code + '，等待房主配置并开始...');
    if (document.getElementById('lobbyArea')) {
        document.getElementById('lobbyArea').style.display = 'block';
    }
    var joinArea = document.getElementById('onlineJoinArea');
    if (joinArea) joinArea.style.display = 'none';
};

NET.onDisconnect = function() {
    if (ONLINE.active) alert('⚠️ 与服务器断开连接，请刷新页面重试。');
};

NET.onSlotLeft = function(slotIdx) {
    if (!ONLINE.active) return;
    var name = (NET.roomState && NET.roomState.slotNames && NET.roomState.slotNames[slotIdx]) || ('Slot' + slotIdx);
    setHint2('⚠️ ' + name + ' 已离线，其控制的角色由 AI 接管');
    ONLINE.handleSlotLeft(slotIdx);
    // 角色刚被 AI 接管，如果当前就是该角色的回合，立即让 AI 行动
    if (window.AI && AI.checkAndAct) setTimeout(function(){ AI.checkAndAct(); }, 600);
};

NET.onError = function(msg) {
    setOnlineStatus('❌ ' + msg);
};

// ── 工具 ──
function setOnlineStatus(msg) {
    var el = document.getElementById('onlineStatus');
    if (el) el.textContent = msg;
}
