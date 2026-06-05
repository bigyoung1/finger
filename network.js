// ════════════════════════════════════════════════════════
//  network.js — 客户端联机层
//  在 index2.html 里引入，负责 WebSocket 连接 + 消息收发
// ════════════════════════════════════════════════════════

var NET = {
    ws:       null,
    seat:     -1,    // 0=先手(HERO队p0), 1=后手(REBEL队p1)
    roomCode: '',
    myName:   '',
    isOnline: false,

    // ── 连接服务器 ──
    connect: function(onOpen) {
        // 自动判断 ws:// 或 wss://（HTTPS 页面必须用 wss）
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

    // ── 发送消息 ──
    send: function(obj) {
        if (NET.ws && NET.ws.readyState === WebSocket.OPEN) {
            NET.ws.send(JSON.stringify(obj));
        }
    },

    // ── 创建房间 ──
    createRoom: function(name) {
        NET.myName = name;
        NET.send({ type: 'create', name: name });
    },

    // ── 加入房间 ──
    joinRoom: function(code, name) {
        NET.myName = name;
        NET.send({ type: 'join', code: code.toUpperCase(), name: name });
    },

    // ── 发送游戏操作（由游戏逻辑层调用）──
    sendAction: function(payload) {
        NET.send({ type: 'action', payload: payload });
    },

    // ── 发送聊天 ──
    sendChat: function(text) {
        NET.send({ type: 'chat', text: text });
    },

    // ════════════════════════════════════════
    //  消息处理（服务器 → 客户端）
    // ════════════════════════════════════════
    handleMessage: function(msg) {
        switch (msg.type) {

            case 'created':
                NET.seat     = 0;
                NET.roomCode = msg.code;
                NET.onRoomCreated(msg.code);
                break;

            case 'joined':
                NET.seat     = 1;
                NET.roomCode = msg.code;
                NET.onRoomJoined(msg.opponentName);
                break;

            case 'opponentJoined':
                NET.onOpponentJoined(msg.opponentName);
                break;

            case 'action':
                // 收到对手的操作，执行它
                NET.onRemoteAction(msg.payload);
                break;

            case 'chat':
                NET.onChat(msg.text);
                break;

            case 'rematch':
                NET.onRematch();
                break;

            case 'opponentLeft':
                NET.onOpponentLeft();
                break;

            case 'error':
                NET.onError(msg.msg);
                break;
        }
    },

    // ════════════════════════════════════════
    //  回调（由 index2.html 覆盖实现）
    // ════════════════════════════════════════
    onRoomCreated:    function(code) {},
    onRoomJoined:     function(opponentName) {},
    onOpponentJoined: function(opponentName) {},
    onRemoteAction:   function(payload) {},
    onChat:           function(text) {},
    onRematch:        function() {},
    onOpponentLeft:   function() {},
    onDisconnect:     function() {},
    onError:          function(msg) { alert('联机错误：' + msg); },
};
