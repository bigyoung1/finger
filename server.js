// ════════════════════════════════════════════════════════
//  指尖博弈 — 联机服务端
//  职责：房间管理 + WebSocket 消息中转（不跑游戏逻辑）
// ════════════════════════════════════════════════════════
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const PORT = process.env.PORT || 3000;

// ── HTTP 服务器（同时托管静态游戏文件）──
const server = http.createServer((req, res) => {
    // 把 URL 映射到本地文件
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index2.html';

    const ext = path.extname(filePath);
    const mime = {
        '.html': 'text/html',
        '.js':   'application/javascript',
        '.css':  'text/css',
        '.json': 'application/json',
        '.png':  'image/png',
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404); res.end('Not found'); return;
        }
        res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
        res.end(data);
    });
});

// ── WebSocket 服务器 ──
const wss = new WebSocket.Server({ server });

// rooms: { roomCode: { p0: ws, p1: ws, seatNames: ['', ''] } }
const rooms = {};

function genCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase(); // 5位大写码
}

function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.seat     = null; // 0 或 1

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // ── 创建房间 ──
            case 'create': {
                const code = genCode();
                rooms[code] = { p0: ws, p1: null, seatNames: [msg.name || '玩家1', ''] };
                ws.roomCode = code;
                ws.seat     = 0;
                send(ws, { type: 'created', code, seat: 0 });
                console.log(`[房间] 创建 ${code}，玩家0: ${msg.name}`);
                break;
            }

            // ── 加入房间 ──
            case 'join': {
                const room = rooms[msg.code];
                if (!room) {
                    send(ws, { type: 'error', msg: '房间不存在' }); break;
                }
                if (room.p1) {
                    send(ws, { type: 'error', msg: '房间已满' }); break;
                }
                room.p1 = ws;
                room.seatNames[1] = msg.name || '玩家2';
                ws.roomCode = msg.code;
                ws.seat     = 1;
                send(ws,     { type: 'joined', code: msg.code, seat: 1, opponentName: room.seatNames[0] });
                send(room.p0, { type: 'opponentJoined', opponentName: room.seatNames[1] });
                console.log(`[房间] ${msg.code} 玩家1加入: ${msg.name}，双方就绪`);
                break;
            }

            // ── 选角色确认（双方都选好后开始游戏）──
            case 'charSelected': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const other = ws.seat === 0 ? room.p1 : room.p0;
                send(other, { type: 'charSelected', seat: ws.seat, chars: msg.chars });
                break;
            }

            // ── 游戏操作（核心：把操作原样转发给对手）──
            case 'action': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const other = ws.seat === 0 ? room.p1 : room.p0;
                send(other, { type: 'action', seat: ws.seat, payload: msg.payload });
                break;
            }

            // ── 聊天/表情 ──
            case 'chat': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const other = ws.seat === 0 ? room.p1 : room.p0;
                send(other, { type: 'chat', seat: ws.seat, text: msg.text });
                break;
            }

            // ── 重新开始 ──
            case 'rematch': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const other = ws.seat === 0 ? room.p1 : room.p0;
                send(other, { type: 'rematch' });
                break;
            }
        }
    });

    ws.on('close', () => {
        const code = ws.roomCode;
        if (!code || !rooms[code]) return;
        const room = rooms[code];
        const other = ws.seat === 0 ? room.p1 : room.p0;
        send(other, { type: 'opponentLeft' });
        delete rooms[code];
        console.log(`[房间] ${code} 已关闭（玩家离线）`);
    });
});

server.listen(PORT, () => {
    console.log(`✅ 指尖博弈服务器运行在 http://localhost:${PORT}`);
});
