// ════════════════════════════════════════════════════════
//  指尖博弈 — 联机服务端 (4-slot 版)
//  职责：房间管理 + WebSocket 消息中转（不跑游戏逻辑）
// ════════════════════════════════════════════════════════
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const PORT = process.env.PORT || 3000;
const WEIGHTS_FILE  = path.join(__dirname, 'ai', 'weights.json');
const KNOWLEDGE_FILE = path.join(__dirname, 'ai', 'knowledge.md');

// ── HTTP 服务器（同时托管静态游戏文件）──
const server = http.createServer((req, res) => {
    const rawUrl = req.url.split('?')[0];
    const url    = decodeURIComponent(rawUrl);
    const query  = req.url.includes('?') ? Object.fromEntries(new URLSearchParams(req.url.split('?')[1])) : {};

    const json  = (obj, code=200) => { res.writeHead(code,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(obj)); };
    const text  = (t, code=200)  => { res.writeHead(code,{'Content-Type':'text/plain;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(t); };
    const body  = () => new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });

    // ── /api/weights  GET 读 / POST 写 ──
    if (url === '/api/weights') {
        if (req.method === 'GET') {
            fs.readFile(WEIGHTS_FILE, 'utf8', (err, data) => {
                if (err) { json({}); return; }
                try { json(JSON.parse(data)); } catch { json({}); }
            });
        } else if (req.method === 'POST') {
            body().then(d => {
                fs.writeFile(WEIGHTS_FILE, d, () => json({ ok: true }));
            });
        }
        return;
    }

    // ── /api/knowledge  GET 读 / POST 追加 ──
    if (url === '/api/knowledge') {
        if (req.method === 'GET') {
            fs.readFile(KNOWLEDGE_FILE, 'utf8', (err, data) => text(err ? '' : data));
        } else if (req.method === 'POST') {
            body().then(d => {
                const { append } = JSON.parse(d);
                fs.appendFile(KNOWLEDGE_FILE, append || '', () => json({ ok: true }));
            });
        }
        return;
    }

    // ── /api/skill?name=法师 ──
    if (url === '/api/skill') {
        const name     = query.name || '';
        const skillPath = path.join(__dirname, 'ai', 'skills', name + '.md');
        const safe      = path.resolve(skillPath);
        if (!safe.startsWith(path.resolve(__dirname, 'ai', 'skills'))) { res.writeHead(403); res.end(); return; }
        fs.readFile(safe, 'utf8', (err, data) => text(err ? '' : data));
        return;
    }

    // ── /api/ai  代理 LLM ──
    if (url === '/api/ai' && req.method === 'POST') {
        body().then(async d => {
            const payload  = JSON.parse(d);
            const provider = payload.provider || 'minimax';
            let endpoint, headers, reqBody;

            if (provider === 'minimax') {
                const apiKey = process.env.MINIMAX_API_KEY || '';
                endpoint = 'https://api.minimaxi.chat/v1/text/chatcompletion_v2';
                headers  = { 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey };
                reqBody  = JSON.stringify({ model:'MiniMax-M1', messages: payload.messages, temperature: payload.temperature||0.35, max_tokens: payload.max_tokens||200 });
            } else {
                const apiKey = process.env.DEEPSEEK_API_KEY || '';
                endpoint = 'https://api.deepseek.com/chat/completions';
                headers  = { 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey };
                reqBody  = JSON.stringify({ model:'deepseek-chat', messages: payload.messages, temperature: payload.temperature||0.35, max_tokens: payload.max_tokens||200 });
            }

            try {
                const https   = require('https');
                const urlParsed = new URL(endpoint);
                const options = { hostname: urlParsed.hostname, path: urlParsed.pathname, method:'POST', headers:{...headers,'Content-Length':Buffer.byteLength(reqBody)} };
                const proxyReq = https.request(options, proxyRes => {
                    let buf = '';
                    proxyRes.on('data', c => buf += c);
                    proxyRes.on('end', () => { res.writeHead(proxyRes.statusCode,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(buf); });
                });
                proxyReq.on('error', e => json({error:e.message}, 500));
                proxyReq.write(reqBody);
                proxyReq.end();
            } catch(e) { json({error:String(e)}, 500); }
        });
        return;
    }

    // ── /api/skill-update  POST 追加角色攻略 ──
    if (url === '/api/skill-update' && req.method === 'POST') {
        body().then(d => {
            const { name, append } = JSON.parse(d);
            const skillPath = path.join(__dirname, 'ai', 'skills', name + '.md');
            const safe      = path.resolve(skillPath);
            if (!safe.startsWith(path.resolve(__dirname, 'ai', 'skills'))) {
                res.writeHead(403); res.end(); return;
            }
            fs.appendFile(safe, append || '', () => json({ ok: true }));
        });
        return;
    }

    // ── /api/log  POST 保存训练日志 ──
    if (url === '/api/log' && req.method === 'POST') {
        body().then(d => {
            const { filename, content } = JSON.parse(d);
            const logDir  = path.join(__dirname, 'log');
            const safe    = path.basename(filename || 'battle.txt').replace(/[^\w\u4e00-\u9fa5_\-\.]/g, '_');
            const logPath = path.join(logDir, safe);
            fs.mkdir(logDir, { recursive: true }, () => {
                fs.writeFile(logPath, content, () => json({ ok: true, file: safe }));
            });
        });
        return;
    }
    if (url === '/api/music') {
        const musicDir = path.join(__dirname, 'music1');
        fs.readdir(musicDir, (err, files) => {
            if (err) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([])); return; }
            const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(mp3s));
        });
        return;
    }

    // 把 URL 映射到本地文件
    let filePath = '.' + decodeURIComponent(url);
    if (filePath === './') filePath = './index2.html';
    const safePath = path.resolve(__dirname, filePath.slice(2));
    if (!safePath.startsWith(path.resolve(__dirname))) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    filePath = safePath;

    const ext = path.extname(filePath);
    const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.md':   'text/plain; charset=utf-8',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.mp3':  'audio/mpeg',
        '.ogg':  'audio/ogg',
        '.wav':  'audio/wav',
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404); res.end('Not found'); return;
        }
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

// ── WebSocket 服务器 ──
const wss = new WebSocket.Server({ server });

/**
 * rooms[code] = {
 *   slots:     [ws|null, ws|null, ws|null, ws|null],  // 最多 4 个 slot
 *   slotNames: [name|'', '', '', ''],
 *   hostSlot:  0,                                      // 房主固定 slot 0
 * }
 */
const rooms = {};

function genCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

// 广播给房间内除 exceptWs 之外的所有人
function broadcast(room, exceptWs, obj) {
    if (!room) return;
    room.slots.forEach(ws => {
        if (ws && ws !== exceptWs) send(ws, obj);
    });
}

// 房间状态摘要（slot 占用情况），用于让所有人看到谁在线
function roomSummary(room) {
    return {
        slotNames: room.slotNames.slice(),
        slotOccupied: room.slots.map(s => !!s),
        hostSlot: room.hostSlot,
    };
}

function broadcastRoomState(room) {
    const summary = roomSummary(room);
    room.slots.forEach(ws => {
        if (ws) send(ws, { type: 'roomState', ...summary });
    });
}

wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.slotIdx  = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create': {
                const code = genCode();
                rooms[code] = {
                    slots:     [ws, null, null, null],
                    slotNames: [msg.name || '玩家1', '', '', ''],
                    hostSlot:  0,
                };
                ws.roomCode = code;
                ws.slotIdx  = 0;
                send(ws, { type: 'created', code, slotIdx: 0, ...roomSummary(rooms[code]) });
                console.log(`[房间] 创建 ${code}，玩家0: ${msg.name}`);
                break;
            }
            case 'join': {
                const room = rooms[msg.code];
                if (!room) { send(ws, { type: 'error', msg: '房间不存在' }); break; }
                // 找第一个空 slot
                const emptyIdx = room.slots.findIndex(s => !s);
                if (emptyIdx === -1) { send(ws, { type: 'error', msg: '房间已满（4人）' }); break; }
                room.slots[emptyIdx]     = ws;
                room.slotNames[emptyIdx] = msg.name || ('玩家' + (emptyIdx + 1));
                ws.roomCode = msg.code;
                ws.slotIdx  = emptyIdx;
                send(ws, { type: 'joined', code: msg.code, slotIdx: emptyIdx, ...roomSummary(room) });
                broadcastRoomState(room);
                console.log(`[房间] ${msg.code} slot${emptyIdx} 加入 (${msg.name})`);
                break;
            }
            case 'action': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                broadcast(room, ws, { type: 'action', fromSlot: ws.slotIdx, payload: msg.payload });
                break;
            }
            case 'chat': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                broadcast(room, ws, { type: 'chat', fromSlot: ws.slotIdx, text: msg.text });
                break;
            }
            case 'rematch': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                broadcast(room, ws, { type: 'rematch', fromSlot: ws.slotIdx });
                break;
            }
        }
    });

    ws.on('close', () => {
        const code = ws.roomCode;
        if (!code || !rooms[code]) return;
        const room = rooms[code];
        const idx  = ws.slotIdx;
        room.slots[idx]     = null;
        room.slotNames[idx] = '';
        // 通知其他人：该 slot 已掉线（让他们把 charControl[i]===idx 的角色改 AI 接管）
        broadcast(room, ws, { type: 'slotLeft', slotIdx: idx });
        // 如果整个房间空了就清掉
        if (room.slots.every(s => !s)) {
            delete rooms[code];
            console.log(`[房间] ${code} 已关闭`);
        } else {
            broadcastRoomState(room);
            console.log(`[房间] ${code} slot${idx} 离开`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`✅ 指尖博弈服务器运行在 http://localhost:${PORT}`);
});
