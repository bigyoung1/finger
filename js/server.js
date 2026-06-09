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
    const url = req.url.split('?')[0]; // 去掉查询参数

    // /api/ai — LLM AI 决策代理，支持 provider: 'minimax' | 'deepseek'
    if (url === '/api/ai' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const provider = payload.provider || 'minimax';

                let apiKey, endpoint, modelName;
                if (provider === 'deepseek') {
                    apiKey   = process.env.DEEPSEEK_API_KEY || 'sk-76c2685331c14d149be64c1d9036f84e';
                    endpoint = 'https://api.deepseek.com/chat/completions';
                    modelName = payload.model || 'deepseek-chat';
                } else {
                    // minimax
                    const mmKeyFile = require('os').homedir() + '/.minimax_api_key';
                    apiKey = process.env.MINIMAX_API_KEY ||
                        (require('fs').existsSync(mmKeyFile) ? require('fs').readFileSync(mmKeyFile,'utf8').trim() : '');
                    endpoint  = 'https://api.minimax.chat/v1/text/chatcompletion_v2';
                    modelName = payload.model || 'MiniMax-M2.7';
                }

                if (!apiKey) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No API key for provider: ' + provider }));
                    return;
                }

                const upstream = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelName,
                        messages: payload.messages,
                        max_tokens: payload.max_tokens || 1024,
                        temperature: payload.temperature || 0.5,
                    })
                });
                const data = await upstream.json();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(data));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: String(e) }));
            }
        });
        return;
    }

    // /api/skill — 读取角色技能文档
    if (url.startsWith('/api/skill') && req.method === 'GET') {
        const name = decodeURIComponent(url.split('=')[1] || '');
        const skillPath = path.join(__dirname, 'ai', 'skills', name + '.md');
        fs.readFile(skillPath, 'utf8', (err, txt) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(err ? '' : txt);
        });
        return;
    }

    // /api/knowledge — 读写 AI 经验知识库
    if (url === '/api/knowledge' && req.method === 'GET') {
        const kbPath = path.join(__dirname, 'ai', 'knowledge.md');
        fs.readFile(kbPath, 'utf8', (err, txt) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(err ? '' : txt);
        });
        return;
    }
    if (url === '/api/knowledge' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { append } = JSON.parse(body);
                const kbPath = path.join(__dirname, 'ai', 'knowledge.md');
                fs.appendFileSync(kbPath, '\n\n' + append);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500); res.end(String(e));
            }
        });
        return;
    }

    // /api/music — 返回 music1 文件夹里的 mp3 列表
    if (url === '/api/music') {
        const musicDir = path.join(__dirname, 'music1');
        fs.readdir(musicDir, (err, files) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return;
            }
            const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(mp3s));
        });
        return;
    }

    // 把 URL 映射到本地文件
    let filePath = '.' + decodeURIComponent(url);
    if (filePath === './') filePath = './index2.html';
    // 安全检查：防止路径穿越
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
        '.webp': 'image/webp',
        '.mp3':  'audio/mpeg',
        '.ogg':  'audio/ogg',
        '.wav':  'audio/wav',
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found'); return;
        }
        res.writeHead(200, {
            'Content-Type': mime[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        });
        res.end(data);
    });
});

// ── WebSocket 服务器 ──
const wss = new WebSocket.Server({ server });

const rooms = {};

function genCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.seat     = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create': {
                const code = genCode();
                rooms[code] = { p0: ws, p1: null, seatNames: [msg.name || '玩家1', ''] };
                ws.roomCode = code;
                ws.seat     = 0;
                send(ws, { type: 'created', code, seat: 0 });
                console.log(`[房间] 创建 ${code}，玩家0: ${msg.name}`);
                break;
            }
            case 'join': {
                const room = rooms[msg.code];
                if (!room) { send(ws, { type: 'error', msg: '房间不存在' }); break; }
                if (room.p1) { send(ws, { type: 'error', msg: '房间已满' }); break; }
                room.p1 = ws;
                room.seatNames[1] = msg.name || '玩家2';
                ws.roomCode = msg.code;
                ws.seat     = 1;
                send(ws,      { type: 'joined', code: msg.code, seat: 1, opponentName: room.seatNames[0] });
                send(room.p0, { type: 'opponentJoined', opponentName: room.seatNames[1] });
                console.log(`[房间] ${msg.code} 双方就绪`);
                break;
            }
            case 'charSelected': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                send(ws.seat === 0 ? room.p1 : room.p0, { type: 'charSelected', seat: ws.seat, chars: msg.chars });
                break;
            }
            case 'action': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                send(ws.seat === 0 ? room.p1 : room.p0, { type: 'action', seat: ws.seat, payload: msg.payload });
                break;
            }
            case 'chat': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                send(ws.seat === 0 ? room.p1 : room.p0, { type: 'chat', seat: ws.seat, text: msg.text });
                break;
            }
            case 'rematch': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                send(ws.seat === 0 ? room.p1 : room.p0, { type: 'rematch' });
                break;
            }
        }
    });

    ws.on('close', () => {
        const code = ws.roomCode;
        if (!code || !rooms[code]) return;
        const room  = rooms[code];
        const other = ws.seat === 0 ? room.p1 : room.p0;
        send(other, { type: 'opponentLeft' });
        delete rooms[code];
        console.log(`[房间] ${code} 已关闭`);
    });
});

server.listen(PORT, () => {
    console.log(`✅ 指尖博弈服务器运行在 http://localhost:${PORT}`);
});
