// ════════════════════════════════════════════════════════
//  指尖博弈 — 联机服务端 (4-slot 版)
//  职责：房间管理 + WebSocket 消息排序/去重 + 房主权威中转（不跑游戏逻辑）
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
                const apiKey = process.env.MINIMAX_API_KEY || 'sk-cp-hQDhqdoZ37_BPo_Dr4U_wWlPtUU4onAprt5oMeg22BZ-Es0jwWqRlpIXQTMSqEbuzUGtjVm2vbh3AKd__7dOfaCdaLPY5OiDsWbJqkE1mJ3WkxV94w_6_TM';
                endpoint = 'https://api.minimaxi.chat/v1/text/chatcompletion_v2';
                headers  = { 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey };
                reqBody  = JSON.stringify({ model:'MiniMax-M1', messages: payload.messages, temperature: payload.temperature||0.35, max_tokens: payload.max_tokens||200 });
            } else if (provider === 'qianfan') {
                // 千帆（讯飞）— 兼容 Anthropic Messages 格式
                const apiKey = process.env.QIANFAN_API_KEY || '5bca12355e6416179ffb18af6aed4b32:OTNjNWFhNjNjNGYyNTAzNDQ4NDg0YjY2';
                endpoint = 'https://maas-api.cn-huabei-1.xf-yun.com/anthropic/v1/messages';
                headers  = { 'Content-Type':'application/json', 'x-api-key': apiKey, 'anthropic-version':'2023-06-01' };
                const sysMsg = payload.messages.find(m => m.role === 'system');
                const otherMsgs = payload.messages.filter(m => m.role !== 'system');
                const bodyObj = {
                    model: 'xopqwen36v35b',
                    max_tokens: payload.max_tokens || 200,
                    temperature: payload.temperature || 0.35,
                    messages: otherMsgs,
                };
                if (sysMsg) bodyObj.system = sysMsg.content;
                reqBody = JSON.stringify(bodyObj);
            } else {
                const apiKey = process.env.DEEPSEEK_API_KEY || 'sk-76c2685331c14d149be64c1d9036f84e';
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
                    proxyRes.on('end', () => {
                        // 千帆返回 Anthropic Messages 格式，统一转成 OpenAI choices 格式给前端
                        if (provider === 'qianfan') {
                            try {
                                const parsed = JSON.parse(buf);
                                // Anthropic格式: { content:[{type:'text',text:'...'}] }
                                const text = parsed?.content?.[0]?.text || parsed?.error?.message || '';
                                const normalized = JSON.stringify({ choices:[{ message:{ role:'assistant', content: text } }] });
                                res.writeHead(200,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
                                res.end(normalized);
                                return;
                            } catch(e) { /* fallthrough */ }
                        }
                        res.writeHead(proxyRes.statusCode,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*'});
                        res.end(buf);
                    });
                });
                proxyReq.on('error', e => json({error:e.message}, 500));
                proxyReq.write(reqBody);
                proxyReq.end();
            } catch(e) { json({error:String(e)}, 500); }
        });
        return;
    }

    // ── /api/skill-weight  POST  更新角色 skill md 中的权重块 + 可选追加复盘文本 ──
    if (url === '/api/skill-weight' && req.method === 'POST') {
        body().then(d => {
            const { name, weights, append } = JSON.parse(d);
            if (!name) { json({ ok: false, error: 'missing name' }, 400); return; }
            const skillPath = path.join(__dirname, 'ai', 'skills', name + '.md');
            const safe = path.resolve(skillPath);
            if (!safe.startsWith(path.resolve(__dirname, 'ai', 'skills'))) {
                json({ ok: false, error: 'invalid name' }, 403); return;
            }
            fs.readFile(safe, 'utf8', (err, content) => {
                if (err) { json({ ok: false, error: err.message }, 500); return; }
                // 更新 ## 权重 下的 JSON 块（匹配 ```json ... ``` 之间的一行 JSON）
                if (weights && Object.keys(weights).length > 0) {
                    const weightJson = JSON.stringify(weights);
                    content = content.replace(
                        /(##\s*权重\s*\n```json\n)[\s\S]*?(\n```)/,
                        `$1${weightJson}$2`
                    );
                }
                // 可选：追加复盘文本
                if (append) {
                    content = content.replace(/\s+$/, '');
                    content += '\n' + append + '\n';
                }
                fs.writeFile(safe, content, 'utf8', () => json({ ok: true }));
            });
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

function genSessionId() {
    return Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 12);
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

// 广播给房间内所有人（包括发送者）。用于大厅配置和开局配置，避免房主/访客各自本地初始化导致分叉。
function broadcastAll(room, obj) {
    if (!room) return;
    room.slots.forEach(ws => {
        if (ws) send(ws, obj);
    });
}

function markActionSeen(room, actionId) {
    if (!room || !actionId) return false;
    if (!room.seenActions) room.seenActions = new Set();
    if (!room.seenActionQueue) room.seenActionQueue = [];
    if (room.seenActions.has(actionId)) return false;
    room.seenActions.add(actionId);
    room.seenActionQueue.push(actionId);
    while (room.seenActionQueue.length > 500) {
        const old = room.seenActionQueue.shift();
        room.seenActions.delete(old);
    }
    return true;
}

function nextRoomSeq(room) {
    room.actionSeq = (room.actionSeq || 0) + 1;
    return room.actionSeq;
}

function ensureActionId(ws, msg) {
    return msg.actionId || (msg.payload && msg.payload._actionId) || `${ws.roomCode || 'room'}:${ws.slotIdx}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getHostSocket(room) {
    if (!room) return null;
    const hostSlot = (typeof room.hostSlot === 'number' && room.hostSlot >= 0) ? room.hostSlot : 0;
    return room.slots[hostSlot] || null;
}

function decoratePayload(payload, meta) {
    const copy = Object.assign({}, payload || {});
    copy._net = Object.assign({}, copy._net || {}, meta || {});
    return copy;
}


function applyRuntimeControlPayload(room, payload) {
    if (!room || !payload) return;
    if (!room.runtimeCharControl) room.runtimeCharControl = [0, 1, 0, 1];
    if (!room.delegatedAI) room.delegatedAI = [false, false, false, false];
    if (payload.type !== 'ctrlUpdate' && payload.type !== 'delegate') return;
    const ci = Number(payload.charIdx ?? payload.playerIdx);
    if (!Number.isInteger(ci) || ci < 0 || ci >= 4) return;

    if (payload.type === 'delegate') {
        const delegated = !!payload.delegate;
        room.delegatedAI[ci] = delegated;
        room.runtimeCharControl[ci] = delegated ? 'AI' : (payload.controller === 'AI' ? 'AI' : Number(payload.controller));
    } else {
        room.delegatedAI[ci] = false;
        room.runtimeCharControl[ci] = payload.controller === 'AI' ? 'AI' : Number(payload.controller);
    }
}

// 房间状态摘要（slot 占用情况），用于让所有人看到谁在线
function roomSummary(room) {
    return {
        slotNames: room.slotNames.slice(),
        slotOccupied: room.slots.map(s => !!s),
        hostSlot: room.hostSlot,
        lobbyConfig: room.lobbyConfig || null,
        gameConfig: room.gameConfig || null,
        runtimeCharControl: room.runtimeCharControl ? room.runtimeCharControl.slice() : null,
        delegatedAI: room.delegatedAI ? room.delegatedAI.slice() : null,
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
                    slotSessions: ['', '', '', ''],
                    hostSlot:  0,
                    actionSeq: 0,
                    seenActions: new Set(),
                    seenActionQueue: [],
                    lobbyConfig: null,
                    gameConfig: null,
                    runtimeCharControl: [0, 1, 0, 1],
                    delegatedAI: [false, false, false, false],
                };
                const sessionId = genSessionId();
                rooms[code].slotSessions[0] = sessionId;
                ws.roomCode = code;
                ws.slotIdx  = 0;
                ws.sessionId = sessionId;
                send(ws, { type: 'created', code, slotIdx: 0, sessionId, ...roomSummary(rooms[code]) });
                console.log(`[房间] 创建 ${code}，玩家0: ${msg.name}`);
                break;
            }
            case 'join': {
                const room = rooms[msg.code];
                if (!room) { send(ws, { type: 'error', msg: '房间不存在' }); break; }
                // 找第一个空 slot
                const emptyIdx = room.slots.findIndex(s => !s);
                if (emptyIdx === -1) { send(ws, { type: 'error', msg: '房间已满（4人）' }); break; }
                const sessionId = genSessionId();
                if (!room.slotSessions) room.slotSessions = ['', '', '', ''];
                room.slots[emptyIdx]     = ws;
                room.slotNames[emptyIdx] = msg.name || ('玩家' + (emptyIdx + 1));
                room.slotSessions[emptyIdx] = sessionId;
                ws.roomCode = msg.code;
                ws.slotIdx  = emptyIdx;
                ws.sessionId = sessionId;
                send(ws, { type: 'joined', code: msg.code, slotIdx: emptyIdx, sessionId, ...roomSummary(room) });
                broadcastRoomState(room);
                console.log(`[房间] ${msg.code} slot${emptyIdx} 加入 (${msg.name})`);
                break;
            }
            case 'rejoin': {
                const room = rooms[msg.code];
                if (!room) { send(ws, { type: 'error', msg: '房间不存在，无法重连' }); break; }
                const slotIdx = Number(msg.slotIdx);
                if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx > 3) { send(ws, { type: 'error', msg: '重连座位无效' }); break; }
                if (!room.slotSessions) room.slotSessions = ['', '', '', ''];
                if (room.slotSessions[slotIdx] !== msg.sessionId) { send(ws, { type: 'error', msg: '重连身份已过期，请重新加入房间' }); break; }
                if (room.slots[slotIdx] && room.slots[slotIdx] !== ws) {
                    try { room.slots[slotIdx].close(4001, 'replaced by reconnect'); } catch (e) {}
                }
                room.slots[slotIdx] = ws;
                if (msg.name) room.slotNames[slotIdx] = msg.name;
                ws.roomCode = msg.code;
                ws.slotIdx = slotIdx;
                ws.sessionId = msg.sessionId;
                send(ws, { type: 'rejoined', code: msg.code, slotIdx, sessionId: msg.sessionId, ...roomSummary(room) });
                broadcast(room, ws, { type: 'slotRejoined', slotIdx, charControl: room.runtimeCharControl ? room.runtimeCharControl.slice() : null });
                broadcastRoomState(room);
                console.log(`[房间] ${msg.code} slot${slotIdx} 重连 (${msg.name || room.slotNames[slotIdx] || ''})`);
                break;
            }
            case 'lobbyUpdate': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                room.lobbyConfig = Object.assign({}, room.lobbyConfig || {}, msg.config || {});
                if (room.lobbyConfig.charControl) room.runtimeCharControl = room.lobbyConfig.charControl.slice();
                const seq = nextRoomSeq(room);
                broadcastAll(room, { type: 'lobbyUpdate', fromSlot: ws.slotIdx, seq, config: room.lobbyConfig });
                break;
            }
            case 'startGameConfig': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                if (ws.slotIdx !== room.hostSlot) {
                    send(ws, { type: 'error', msg: '只有房主可以同步开局；已向房主请求开始。' });
                    const host = getHostSocket(room);
                    if (host) send(host, { type: 'startRequest', fromSlot: ws.slotIdx });
                    break;
                }
                room.gameConfig = msg.config || room.lobbyConfig || {};
                room.lobbyConfig = Object.assign({}, room.lobbyConfig || {}, room.gameConfig || {});
                if (room.gameConfig.charControl) room.runtimeCharControl = room.gameConfig.charControl.slice();
                const seq = nextRoomSeq(room);
                broadcastAll(room, { type: 'startGameConfig', fromSlot: ws.slotIdx, seq, config: room.gameConfig });
                break;
            }
            case 'action': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const actionId = ensureActionId(ws, msg);
                if (!markActionSeen(room, actionId)) {
                    send(ws, { type: 'actionAck', actionId, duplicate: true });
                    break;
                }
                applyRuntimeControlPayload(room, msg.payload);
                const seq = nextRoomSeq(room);
                const payload = decoratePayload(msg.payload, {
                    actionId,
                    seq,
                    fromSlot: ws.slotIdx,
                    authoritative: ws.slotIdx === room.hostSlot
                });
                broadcast(room, ws, { type: 'action', fromSlot: ws.slotIdx, actionId, seq, payload });
                send(ws, { type: 'actionAck', actionId, seq });
                break;
            }
            case 'actionRequest': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const host = getHostSocket(room);
                if (!host) {
                    send(ws, { type: 'error', msg: '房主不在线，无法执行权威操作；请重新建房。' });
                    break;
                }
                const actionId = ensureActionId(ws, msg);
                if (!markActionSeen(room, 'req:' + actionId)) {
                    send(ws, { type: 'actionAck', actionId, duplicate: true, requested: true });
                    break;
                }
                // 兼容旧客户端：如果托管/控制权仍走房主请求，也先把服务端运行时控制权记住，避免切后台重连后被旧控制权覆盖。
                applyRuntimeControlPayload(room, msg.payload);
                send(host, {
                    type: 'actionRequest',
                    fromSlot: ws.slotIdx,
                    actionId,
                    payload: decoratePayload(msg.payload, { actionId, requestFromSlot: ws.slotIdx, requested: true })
                });
                send(ws, { type: 'actionAck', actionId, requested: true });
                break;
            }
            case 'startRequest': {
                const room = rooms[ws.roomCode];
                if (!room) break;
                const host = getHostSocket(room);
                if (!host) {
                    send(ws, { type: 'error', msg: '房主不在线，无法开始游戏；请重新建房。' });
                    break;
                }
                // 非房主点击“开始游戏”时，只把请求转给房主；由房主生成并广播 charConfig，避免多端各自初始化。
                send(host, { type: 'startRequest', fromSlot: ws.slotIdx });
                send(ws, { type: 'actionAck', requested: true, startRequest: true });
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
        // 如果这个 close 来自被新重连连接替换掉的旧 ws，不要把新连接踢掉。
        if (room.slots[idx] !== ws) return;
        room.slots[idx]     = null;
        // 保留 slotNames/slotSessions，允许短线后按原座位重连。
        // 通知其他人：该 slot 已掉线（让他们把 charControl[i]===idx 的角色改 AI 接管）
        broadcast(room, ws, { type: 'slotLeft', slotIdx: idx });
        // 如果整个房间空了就清掉；否则房主离线时转移给第一个在线 slot
        if (room.slots.every(s => !s)) {
            delete rooms[code];
            console.log(`[房间] ${code} 已关闭`);
        } else {
            if (idx === room.hostSlot || !room.slots[room.hostSlot]) {
                room.hostSlot = room.slots.findIndex(s => !!s);
                broadcast(room, null, { type: 'hostChanged', hostSlot: room.hostSlot });
                console.log(`[房间] ${code} 房主切换到 slot${room.hostSlot}`);
            }
            broadcastRoomState(room);
            console.log(`[房间] ${code} slot${idx} 离开`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`✅ 指尖博弈服务器运行在 http://localhost:${PORT}`);
});