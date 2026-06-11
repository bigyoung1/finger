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

    sendAction: function(payload) {
        NET.send({ type: 'action', payload: payload });
    },

    sendChat: function(text) {
        NET.send({ type: 'chat', text: text });
    },

    handleMessage: function(msg) {
        switch (msg.type) {

            case 'created':
                NET.slotIdx  = msg.slotIdx;
                NET.roomCode = msg.code;
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot };
                NET.onRoomCreated(msg.code);
                NET.onRoomState(NET.roomState);
                break;

            case 'joined':
                NET.slotIdx  = msg.slotIdx;
                NET.roomCode = msg.code;
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot };
                NET.onRoomJoined(msg.code);
                NET.onRoomState(NET.roomState);
                break;

            case 'roomState':
                NET.roomState = { slotNames: msg.slotNames, slotOccupied: msg.slotOccupied, hostSlot: msg.hostSlot };
                NET.onRoomState(NET.roomState);
                break;

            case 'slotLeft':
                NET.onSlotLeft(msg.slotIdx);
                break;

            case 'action':
                NET.onRemoteAction(msg.payload, msg.fromSlot);
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
    onRemoteAction: function(payload, fromSlot) {},
    onChat:         function(text, fromSlot) {},
    onRematch:      function() {},
    onDisconnect:   function() {},
    onError:        function(msg) { alert('联机错误：' + msg); },
};
