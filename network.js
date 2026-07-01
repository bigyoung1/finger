// ════════════════════════════════════════════════════════
//  network.js — 客户端联机层 (4-slot 版)
// ════════════════════════════════════════════════════════

var NET = {
    ws:        null,
    slotIdx:   -1,    // 0~3，我的座位序号
    roomCode:  '',
    myName:    '',
    isOnline:  false,
    roomState: null,  // 最近一次 roomState 快照
    lastSeq:   0,     // 最近一次服务端排序号
    seenActions: {},  // actionId 去重表

    connect: function(onOpen) {
        var protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        var url = protocol + '://' + location.host;
        NET.ws = new WebSocket(url);

        NET.ws.onopen = function() {
            NET.isOnline = true;
            if (onOpen) onOpen();
        };
        NET.ws.onclose = function() {
            NET.isOnline = false;
            NET.onDisconnect();
        };
        NET.ws.onmessage = function(e) {
            var msg = JSON.parse(e.data);
            NET.handleMessage(msg);
        };
    },

    send: function(obj) {
        if (NET.ws && NET.ws.readyState === WebSocket.OPEN) {
            NET.ws.send(JSON.stringify(obj));
        }
    },

    createRoom: function(name) {
        NET.myName = name;
        NET.send({ type: 'create', name: name });
    },

    joinRoom: function(code, name) {
        NET.myName = name;
        NET.send({ type: 'join', code: code.toUpperCase(), name: name });
    },

    makeActionId: function(prefix) {
        NET._localActionSeq = (NET._localActionSeq || 0) + 1;
        return (NET.roomCode || 'local') + ':' + NET.slotIdx + ':' + (prefix || 'a') + ':' + Date.now() + ':' + NET._localActionSeq;
    },

    markSeen: function(actionId) {
        if (!actionId) return true;
        if (NET.seenActions[actionId]) return false;
        NET.seenActions[actionId] = Date.now();
        var keys = Object.keys(NET.seenActions);
        if (keys.length > 800) {
            keys.sort(function(a,b){ return NET.seenActions[a] - NET.seenActions[b]; });
            keys.slice(0, keys.length - 500).forEach(function(k){ delete NET.seenActions[k]; });
        }
        return true;
    },

    sendAction: function(payload, opts) {
        opts = opts || {};
        payload = payload || {};
        var actionId = opts.actionId || payload._actionId || NET.makeActionId(payload.type || 'action');
        payload._actionId = actionId;
        NET.send({ type: 'action', actionId: actionId, payload: payload });
        return actionId;
    },

    requestAction: function(payload, opts) {
        opts = opts || {};
        payload = payload || {};
        var actionId = opts.actionId || payload._actionId || NET.makeActionId('req_' + (payload.type || 'action'));
        payload._actionId = actionId;
        NET.send({ type: 'actionRequest', actionId: actionId, payload: payload });
        return actionId;
    },

    sendStartRequest: function() {
        NET.send({ type: 'startRequest' });
    },

    sendLobbyUpdate: function(config) {
        NET.send({ type: 'lobbyUpdate', config: config || {} });
    },

    sendStartGameConfig: function(config) {
        NET.send({ type: 'startGameConfig', config: config || {} });
    },

    sendChat: function(text) {
        NET.send({ type: 'chat', text: text });
    },

    handleMessage: function(msg) {
        switch (msg.type) {

            case 'created':
                NET.slotIdx  = msg.slotIdx;
                NET.roomCode = msg.code;
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot, lobbyConfig: msg.lobbyConfig || null, gameConfig: msg.gameConfig || null };
                NET.onRoomCreated(msg.code);
                NET.onRoomState(NET.roomState);
                break;

            case 'joined':
                NET.slotIdx  = msg.slotIdx;
                NET.roomCode = msg.code;
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot, lobbyConfig: msg.lobbyConfig || null, gameConfig: msg.gameConfig || null };
                NET.onRoomJoined(msg.code);
                NET.onRoomState(NET.roomState);
                break;

            case 'roomState':
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot, lobbyConfig: msg.lobbyConfig || null, gameConfig: msg.gameConfig || null };
                NET.onRoomState(NET.roomState);
                break;

            case 'slotLeft':
                NET.onSlotLeft(msg.slotIdx);
                break;

            case 'lobbyUpdate':
                if (msg.seq && msg.seq > NET.lastSeq) NET.lastSeq = msg.seq;
                if (!NET.roomState) NET.roomState = {};
                NET.roomState.lobbyConfig = msg.config || null;
                NET.onLobbyUpdate(msg.config || {}, msg.fromSlot, msg.seq);
                break;

            case 'startGameConfig':
                if (msg.seq && msg.seq > NET.lastSeq) NET.lastSeq = msg.seq;
                if (!NET.roomState) NET.roomState = {};
                NET.roomState.gameConfig = msg.config || null;
                NET.roomState.lobbyConfig = msg.config || NET.roomState.lobbyConfig || null;
                NET.onStartGameConfig(msg.config || {}, msg.fromSlot, msg.seq);
                break;

            case 'action':
                if (msg.seq && msg.seq <= NET.lastSeq) {
                    // 允许重连/乱序时记录，但不因为序号过小重复执行。
                } else if (msg.seq) {
                    NET.lastSeq = msg.seq;
                }
                if (NET.markSeen(msg.actionId || (msg.payload && msg.payload._actionId))) {
                    NET.onRemoteAction(msg.payload, msg.fromSlot, msg.seq, msg.actionId);
                }
                break;

            case 'actionRequest':
                NET.onActionRequest(msg.payload, msg.fromSlot, msg.actionId);
                break;

            case 'actionAck':
                NET.onActionAck(msg);
                break;

            case 'hostChanged':
                if (NET.roomState) NET.roomState.hostSlot = msg.hostSlot;
                NET.onHostChanged(msg.hostSlot);
                break;

            case 'startRequest':
                NET.onStartRequest(msg.fromSlot);
                break;

            case 'chat':
                NET.onChat(msg.text, msg.fromSlot);
                break;

            case 'rematch':
                NET.onRematch();
                break;

            case 'error':
                NET.onError(msg.msg);
                break;
        }
    },

    // ── 回调（由游戏层覆盖实现）──
    onRoomCreated:  function(code) {},
    onRoomJoined:   function(code) {},
    onRoomState:    function(state) {},
    onSlotLeft:     function(slotIdx) {},
    onRemoteAction: function(payload, fromSlot, seq, actionId) {},
    onActionRequest:function(payload, fromSlot, actionId) {},
    onActionAck:    function(msg) {},
    onHostChanged:  function(hostSlot) {},
    onStartRequest: function(fromSlot) {},
    onLobbyUpdate:  function(config, fromSlot, seq) {},
    onStartGameConfig: function(config, fromSlot, seq) {},
    onChat:         function(text, fromSlot) {},
    onRematch:      function() {},
    onDisconnect:   function() {},
    onError:        function(msg) { alert('联机错误：' + msg); },
};
