
// 角色图片映射（文件名和角色ID对应）
var _AVATAR_MAP = {
    '小乔': '小乔', '大乔': '大乔', '藏师': '藏师', '法师': '法师','杨大力':'杨大力', '功夫熊猫': '功夫熊猫',    '孙悟空': '孙悟空', '忍者': '忍者', '张飞': '张飞', '阴阳师': '阴阳师', '鸦眼': '鸦眼',
    '赵云': '赵云', '功夫熊猫': '功夫熊猫'
};
var _avatarsInited = false;

function _initAvatars() {
    if (_avatarsInited || !Main.turnManager) return;
    _avatarsInited = true;
    var players = Main.turnManager.players;
    for (var i = 0; i < players.length; i++) {
        var imgEl = document.getElementById('avatar_' + i);
        if (!imgEl) continue;
        var fname = _AVATAR_MAP[players[i].name];
        var ph = document.getElementById('avatar_ph_' + i);
        if (fname) {
            imgEl.src = 'image/' + encodeURIComponent(fname) + '.png';
            imgEl.alt = players[i].name;
            imgEl.onload = function(el, p) { return function() {
                el.style.display = 'block';
                if (p) p.style.display = 'none';
            }; }(imgEl, ph);
            imgEl.onerror = function() {}; // 图片不存在时保留placeholder
        }
    }
}

// ── rAF 批量渲染：同一帧内多次调用只执行一次，避免重复DOM操作 ──
var _renderPending = false;
var _stylesPending = false;

function render2() {
    if (_renderPending) return;
    _renderPending = true;
    requestAnimationFrame(function() {
        _renderPending = false;
        _doRender2();
    });
}

function refreshHandStyles2() {
    if (_stylesPending) return;
    _stylesPending = true;
    requestAnimationFrame(function() {
        _stylesPending = false;
        _doRefreshHandStyles2();
    });
}

// ════════════════════════════════════════════════════════
//  game2-render.js  渲染 + 手牌样式
// ════════════════════════════════════════════════════════

var SHIELD_NAMES = {
    PHYSICAL:            '物理护盾',
    MAGIC:               '法术护盾',
    BOTH_PHYSICAL_MAGIC: '物法护盾',
    TRUE:                '真实护盾',
};

// VFX 快照（每次 render 前保存旧状态，render 后对比触发特效）
var _vfxSnapshot = [];

function _doRender2() {
    if (!Main.turnManager) return;
    var players = Main.turnManager.players;
    if (!players || players.length < 4) return;

    // 记录 render 前状态（用于 VFX 差量对比）
    var prevSnap = _vfxSnapshot.slice();

    document.getElementById('turnBadge').textContent = '第 ' + Main.turnManager.turnCount + ' 回合';
    var curIdx  = Main.turnManager.currentPlayerIdx;
    var gameOver = Main.turnManager.gameOver;

    for (var i = 0; i < 4; i++) {
        var p = players[i];
        var dead = p.hp <= 0;
        _vfxSnapshot[i] = {
            hp: p.hp,
            shieldCount: (p.shieldList || []).filter(function(s){return s.amount > 0;}).length,
            shieldAmount: (p.shieldList || []).reduce(function(sum,s){return sum+(s.amount>0?s.amount:0);}, 0)
        };

        // 基本信息
        document.getElementById('name2v_'  + i).textContent = p.name;
        document.getElementById('hp2v_'    + i).textContent = dead ? '💀 阵亡' : p.hp;
        document.getElementById('h2v_' + i + '_0').textContent = p.hands[0];
        document.getElementById('h2v_' + i + '_1').textContent = p.hands[1];

        // 卡片高亮
        var card = document.getElementById('card2v_' + i);
        card.className = 'player-card2' +
            (dead ? ' dead' : '') +
            (!dead && i === curIdx && !gameOver ? ' active' : '');

        // 0倒计时
        _toggleDeadClock(i, 0, p.hands[0] === 0, p.zeroTurns0);
        _toggleDeadClock(i, 1, p.hands[1] === 0, p.zeroTurns1);

        // Buff
        var buffText = '';
        p.buffList.forEach(function(b) { buffText += '[' + b.name + ' x' + b.layers + '] '; });
        document.getElementById('buffs2v_' + i).textContent = buffText || '无';

        // 护盾
        var shText = '';
        p.shieldList.forEach(function(s) {
            var tn = SHIELD_NAMES[String(s.type)] || String(s.type);
            shText += '[' + tn + ' ' + s.amount + '/' + s.duration + '回合] ';
        });
        document.getElementById('shields2v_' + i).textContent = shText || '无';

        // 自定义显示
        var custEl = document.getElementById('custom2v_' + i);
        var custHtml = p.getCustomDisplay ? p.getCustomDisplay() : '';
        custEl.style.display = custHtml ? 'block' : 'none';
        if (custHtml) custEl.innerHTML = custHtml;

        // 自定义按钮：普通角色只在自己行动回合显示；功夫熊猫“抗伤单位”按钮可任意时刻切换。
        var actEl = document.getElementById('actions2v_' + i);
        actEl.innerHTML = '';
        // 联机时只给我实际控制的角色显示自定义操作按钮（蛋糕/模态切换等）
        var isMyChar = !ONLINE.active || (ONLINE.charControl[i] === ONLINE.slotIdx);
        if (!gameOver && !dead && p.getCustomActions && isMyChar) {
            p.getCustomActions().forEach(function(a) {
                if (!a.enabled) return;
                var jsCode = a.onClickJS.replace(/__IDX__/g, String(i));
                if (typeof invokeAction2 === 'function') {
                    jsCode = jsCode.replace(/Main\.invokeAction\(/g, 'invokeAction2(');
                }
                var isPandaGuard = (p.name === '功夫熊猫') && jsCode.indexOf('pandaToggleGuard') >= 0;
                // 模态/造罩仍只能在功夫熊猫自己的行动回合点；抗伤按钮随时可点。
                if (i !== curIdx && !isPandaGuard) return;

                var btn = document.createElement('button');
                btn.textContent = a.label;
                var isWhite = String(a.color).toLowerCase() === '#ffffff' || String(a.color).toLowerCase() === 'white';
                btn.style.cssText = 'margin:3px 3px 0 0;background:' + a.color +
                    ';color:' + (isWhite ? '#262626' : 'white') +
                    ';border:' + (isWhite ? '1px solid #d9d9d9' : 'none') +
                    ';padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
                btn.onclick = function() { eval(jsCode); };
                actEl.appendChild(btn);
            });
        }
    }

    _initAvatars();
    // 坦克攻击目标按钮（坦脆vs坦脆时显示）
    if (typeof updateTankTargetButtons === "function") updateTankTargetButtons();

    // 终局提示
    if (gameOver) {
        var winMsg = Main.turnManager.winningCamp
            ? '🏆 获胜：' + String(Main.turnManager.winningCamp) + ' 队！'
            : '💀 全场平局！';
        setHint2(winMsg);
        document.getElementById('hintBar2').style.cssText =
            'background:#f6ffed;border-color:#52c41a;color:#237804;';
    }

    // VFX 差量触发
    if (window.VFX && prevSnap.length > 0) {
        for (var vi = 0; vi < players.length; vi++) {
            var prev = prevSnap[vi];
            var curr = _vfxSnapshot[vi];
            if (!prev || !curr) continue;
            var hpDiff = curr.hp - prev.hp;

            // ── 受伤斩击：从 damageQueue 取伤害类型（精确，不猜测）──
            if (hpDiff < -8) {
                var dtype = 'PHYSICAL';
                var dq = VFX._damageQueue && VFX._damageQueue[vi];
                if (dq && dq.length > 0) {
                    dtype = dq[dq.length - 1]; // 取最后一笔
                } else {
                    // fallback：读 lastTouchDamageLog
                    var log = Main.engine && Main.engine.lastTouchDamageLog;
                    if (log && log.length > 0) {
                        var tn = log[log.length-1].typeName;
                        dtype = tn === '法术' ? 'MAGIC' : tn === '真实' ? 'TRUE' : 'PHYSICAL';
                    }
                }
                VFX.slash(vi, dtype);
                if (hpDiff < -60) VFX.screenShake(Math.min(3, Math.ceil(-hpDiff / 80)));
            }
            // 清空 damageQueue
            if (VFX._damageQueue) VFX._damageQueue[vi] = [];

            // ── 回血加号：从 healQueue 取类型 ──
            if (hpDiff > 5) {
                var hq = VFX._healQueue && VFX._healQueue[vi];
                var healType = (hq && hq.length > 0) ? hq[hq.length - 1] : 'RECOVERY';
                VFX.heal(vi, healType);
            }
            // 清空 healQueue
            if (VFX._healQueue) VFX._healQueue[vi] = [];

            // ── 护盾特效：用正确的字段名 shieldCount / shieldAmount ──
            var shieldAdded = (curr.shieldCount > prev.shieldCount) ||
                              (curr.shieldAmount > prev.shieldAmount + 5);
            if (shieldAdded) {
                var shields = players[vi].shieldList || [];
                var lastSh = shields.filter(function(s){return s.amount>0;}).pop();
                var st = 'PHYSICAL';
                if (lastSh) {
                    var sn = String(lastSh.type||'');
                    if (sn.indexOf('MAGIC')>=0 && sn.indexOf('PHYSICAL')>=0) st = 'BOTH';
                    else if (sn.indexOf('MAGIC')>=0) st = 'MAGIC';
                    else if (sn.indexOf('TRUE')>=0) st = 'TRUE';
                }
                VFX.shield(vi, st);
            }
        }
    }
}

function _toggleDeadClock(playerIdx, handIdx, isZero, turns) {
    var box = document.getElementById('h2v_' + playerIdx + '_' + handIdx + '_box');
    var txt = document.getElementById('dt2v_' + playerIdx + '_' + handIdx);
    if (!box || !txt) return;
    var hasClock = isZero && turns > 0;
    // 保留 hand-box2，切换 death-clock
    var base = 'hand-box2';
    box.className = hasClock ? base + ' death-clock' : base;
    txt.textContent = hasClock ? ('0剩余: ' + turns + '步') : '';
}

function _doRefreshHandStyles2() {
    if (!Main.turnManager || Main.turnManager.players.length < 4) return;
    var players   = Main.turnManager.players;
    var actorIdx  = Main.turnManager.currentPlayerIdx;
    var actor     = players[actorIdx];
    var actorCamp = campOf(actorIdx);
    var gameOver  = Main.turnManager.gameOver;
    var enemyCamp = actorCamp === 'hero' ? 'rebel' : 'hero';
    var fakeTarget = players[G.tankIdx[enemyCamp]];

    for (var pi = 0; pi < 4; pi++) {
        var p     = players[pi];
        var pCamp = campOf(pi);
        var dead  = p.hp <= 0;

        for (var hi = 0; hi < 2; hi++) {
            var box = document.getElementById('h2v_' + pi + '_' + hi + '_box');
            if (!box) continue;

            // 保留 death-clock 状态
            var hasClock = p.hands[hi] === 0 && ((hi === 0 ? p.zeroTurns0 : p.zeroTurns1) > 0);
            var base = 'hand-box2' + (hasClock ? ' death-clock' : '');

            if (gameOver || dead) { box.className = base; continue; }

            if (G.step === 0) {
                if (pi === actorIdx) {
                    var canMove = !actor.isValidTouch ||
                                  actor.isValidTouch(hi, fakeTarget, 0) ||
                                  actor.isValidTouch(hi, fakeTarget, 1);
                    box.className = base + (canMove ? ' clickable-mine' : ' locked');
                } else {
                    box.className = base;
                }
            } else {
                if (pi === actorIdx && hi === G.myHandIdx) {
                    box.className = base + ' selected-mine';
                } else if (pi === actorIdx) {
                    box.className = base; // 另一只手，不高亮
                } else if (pCamp !== actorCamp) {
                    // 敌方：非0可点
                    box.className = base + (p.hands[hi] !== 0 ? ' clickable-enemy' : ' locked');
                } else {
                    box.className = base; // 队友：不可点
                }
            }
        }
    }
}

// ── 角色卡片小提示：非阻塞，不影响游戏进程，3秒自动关闭，可手动关闭 ──
var _cardToastTimers2 = {};
var _cardToastLast2 = {};

function showCardToast2(playerIdx, msg, isError, durationMs) {
    durationMs = durationMs || 3000;
    msg = String(msg || '');
    if (!msg) return;

    var card = document.getElementById('card2v_' + playerIdx);
    if (!card) {
        if (typeof flashHint2 === 'function' && isError) flashHint2(msg);
        else if (typeof setHint2 === 'function') setHint2(msg);
        return;
    }

    var dedupeKey = playerIdx + '|' + msg;
    var now = Date.now();
    if (_cardToastLast2[dedupeKey] && now - _cardToastLast2[dedupeKey] < 1200) return;
    _cardToastLast2[dedupeKey] = now;

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

    var old = document.getElementById('cardToast2_' + playerIdx);
    if (old) old.remove();
    clearTimeout(_cardToastTimers2[playerIdx]);

    var toast = document.createElement('div');
    toast.id = 'cardToast2_' + playerIdx;
    toast.className = 'card-toast2' + (isError ? ' error' : ' info');
    toast.style.cssText = [
        'position:absolute',
        'right:8px',
        'bottom:8px',
        'z-index:80',
        'max-width:calc(100% - 16px)',
        'display:flex',
        'align-items:flex-start',
        'gap:6px',
        'padding:7px 9px',
        'border-radius:8px',
        'font-size:12px',
        'line-height:1.35',
        'box-shadow:0 4px 14px rgba(0,0,0,.18)',
        'background:' + (isError ? '#fff1f0' : '#e6f7ff'),
        'border:1px solid ' + (isError ? '#ff7875' : '#91d5ff'),
        'color:' + (isError ? '#a8071a' : '#003a8c'),
        'pointer-events:auto'
    ].join(';');

    var text = document.createElement('div');
    text.textContent = msg;
    text.style.cssText = 'flex:1;word-break:break-word;';

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭';
    close.style.cssText = [
        'border:none',
        'background:transparent',
        'color:inherit',
        'font-size:14px',
        'font-weight:bold',
        'line-height:1',
        'cursor:pointer',
        'padding:0 0 0 4px'
    ].join(';');
    close.onclick = function(ev) {
        if (ev) ev.stopPropagation();
        clearTimeout(_cardToastTimers2[playerIdx]);
        toast.remove();
    };

    toast.appendChild(text);
    toast.appendChild(close);
    card.appendChild(toast);

    _cardToastTimers2[playerIdx] = setTimeout(function() {
        var el = document.getElementById('cardToast2_' + playerIdx);
        if (el) el.remove();
    }, durationMs);
}
window.showCardToast2 = showCardToast2;

// 兼容旧调用名
function _setCardHint(msg, isError, playerIdx) {
    showCardToast2(playerIdx == null ? (Main && Main.turnManager ? Main.turnManager.currentPlayerIdx : 0) : playerIdx, msg, isError);
}

function setHint2(msg) {
    var bar = document.getElementById('hintBar2');
    if (!bar) return;
    bar.textContent = msg;
    bar.style.background = '#fffbe6';
    bar.style.borderColor = '#ffe58f';
    bar.style.color = '#874d00';
}
function flashHint2(msg) {
    var bar = document.getElementById('hintBar2');
    if (!bar) return;
    bar.textContent = msg;
    bar.style.background = '#fff1f0';
    bar.style.borderColor = '#ffa39e';
    bar.style.color = '#cf1322';
}

function resetAvatars() {
    _avatarsInited = false;
    for (var i = 0; i < 4; i++) {
        var imgEl = document.getElementById('avatar_' + i);
        var ph    = document.getElementById('avatar_ph_' + i);
        if (imgEl) { imgEl.src = ''; imgEl.style.display = 'none'; }
        if (ph)    { ph.style.display = ''; }
    }
}