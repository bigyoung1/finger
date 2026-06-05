// ════════════════════════════════════════════════════════
//  game2-online.js  联机协调层
//  职责：回合归属判断 + 操作发送 + 远端操作接收执行
// ════════════════════════════════════════════════════════

var ONLINE = {
    active: false,   // 是否联机模式
    seat:   -1,      // 0=HERO队, 1=REBEL队
    waitingRemoteHelpTank: false, // 等对方决定帮抗

    myCamp: function() { return ONLINE.seat === 0 ? 'hero' : 'rebel'; },

    // 当前是否轮到我操作（我方阵营的角色行动中）
    isMyTurn: function() {
        if (!ONLINE.active || !Main.turnManager) return true; // 本地模式始终返回true
        var actorIdx  = Main.turnManager.currentPlayerIdx;
        var actorCamp = campOf(actorIdx);
        return (ONLINE.seat === 0 && actorCamp === 'hero') ||
               (ONLINE.seat === 1 && actorCamp === 'rebel');
    },

    // 发送操作（本地执行后调用）
    sendAction: function(payload) {
        if (ONLINE.active) NET.sendAction(payload);
    }
};

// ── 注册远端消息处理 ──
// 对手发来的操作在这里接收并执行（不再回发，避免循环）
NET.onRemoteAction = function(payload) {
    switch (payload.type) {

        case 'attack':
            doAttack2(
                payload.actorIdx, payload.myHand,
                payload.touchTargetIdx, payload.touchHandIdx,
                payload.dmgTargetIdx,
                true  // fromRemote=true，不再回发
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
            // 对方已决定帮抗（我方是攻击方，等待对方的决定）
            ONLINE.waitingRemoteHelpTank = false;
            G.inputLocked = false;
            if (payload.choice === 'confirm') {
                Main.engine.resolveHelpTank(payload.helperIdx);
            }
            // 无论确认还是取消，都推进回合
            render2(); refreshHandStyles2(); finishTurn2();
            break;

        case 'cake':
            // 对方用蛋糕
            Main.invokeAction(payload.actorIdx, 'useCake', { target: payload.targetIdx, groups: payload.groups });
            render2(); refreshHandStyles2(); finishTurn2();
            break;

        case 'steal':
            // 对方（大乔所在方）已决定，我方同步执行
            if (payload.choice === 'confirm') {
                Main.invokeAction(payload.daQiaoIdx, 'doSteal', { healerIdx: payload.healerIdx, netHeal: payload.netHeal });
                render2();
            }
            // cancel 不需要操作，什么都不发生
            break;
    }
};

NET.onOpponentJoined = function(opponentName) {
    setOnlineStatus('对手 ' + opponentName + ' 已加入！房主请选择角色并开始游戏。');
    document.getElementById('onlineStartArea').style.display = 'block';
};

NET.onRoomCreated = function(code) {
    document.getElementById('roomCodeDisplay').textContent = code;
    document.getElementById('roomCodeArea').style.display = 'block';
    setOnlineStatus('房间已创建，等待对手加入...');
};

NET.onRoomJoined = function(opponentName) {
    setOnlineStatus('已加入房间！对手：' + opponentName + '。等待房主开始游戏...');
    // 隐藏创建/加入区域，显示等待
    document.getElementById('onlineJoinArea').style.display = 'none';
};

NET.onDisconnect = function() {
    if (ONLINE.active) alert('⚠️ 与服务器断开连接，请刷新页面重试。');
};

NET.onOpponentLeft = function() {
    if (ONLINE.active) {
        G.inputLocked = false;
        alert('对手已离线，本局结束。');
    }
};

NET.onError = function(msg) {
    setOnlineStatus('❌ ' + msg);
};

// ── 角色配置同步（房主发送，访客接收后开始游戏）──
NET.onRemoteAction_charConfig = function(payload) {
    // 访客收到角色配置，直接开始游戏
    var ids = payload.charIds; // [id0, id1, id2, id3]
    ONLINE.active = true;
    ONLINE.seat   = 1; // 访客=REBEL
    startOnlineGame(ids[0], ids[1], ids[2], ids[3]);
};

// 覆盖 handleMessage 以处理 charConfig（服务器用 action 类型传）
var _origHandleMessage = NET.handleMessage.bind(NET);
NET.handleMessage = function(msg) {
    if (msg.type === 'action' && msg.payload && msg.payload.type === 'charConfig') {
        NET.onRemoteAction_charConfig(msg.payload);
        return;
    }
    _origHandleMessage(msg);
};

// ── 工具函数 ──
function setOnlineStatus(msg) {
    var el = document.getElementById('onlineStatus');
    if (el) el.textContent = msg;
}
