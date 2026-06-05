
// 角色图片映射（文件名和角色ID对应）
var _AVATAR_MAP = {
    '小乔': '小乔', '大乔': '大乔', '藏师': '藏师', '法师': '法师',
    '孙悟空': '孙悟空', '忍者': 'Sni忍者', '张飞': '张飞', '阴阳师': '阴阳师'
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

function _doRender2() {
    if (!Main.turnManager) return;
    var players = Main.turnManager.players;
    if (!players || players.length < 4) return;

    document.getElementById('turnBadge').textContent = '第 ' + Main.turnManager.turnCount + ' 回合';
    var curIdx  = Main.turnManager.currentPlayerIdx;
    var gameOver = Main.turnManager.gameOver;

    for (var i = 0; i < 4; i++) {
        var p = players[i];
        var dead = p.hp <= 0;

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

        // 自定义按钮（只在当前行动者回合显示）
        var actEl = document.getElementById('actions2v_' + i);
        actEl.innerHTML = '';
        // 联机时只给本方阵营显示自定义操作按钮（蛋糕/模态切换等）
        var isMyChar = !ONLINE.active || (campOf(i) === ONLINE.myCamp());
        if (i === curIdx && !gameOver && !dead && p.getCustomActions && isMyChar) {
            p.getCustomActions().forEach(function(a) {
                if (!a.enabled) return;
                var btn = document.createElement('button');
                btn.textContent = a.label;
                btn.style.cssText = 'margin:3px 3px 0 0;background:' + a.color +
                    ';color:white;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
                var jsCode = a.onClickJS.replace(/__IDX__/g, String(i));
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

// ── 提示栏 ──
function _setCardHint(msg, isError) {
    // 清所有卡片的提示
    for (var i = 0; i < 4; i++) {
        var h = document.getElementById('hint2v_' + i);
        if (h) h.style.display = 'none';
    }
    if (!msg || !Main.turnManager) return;
    var idx = Main.turnManager.currentPlayerIdx;
    var h = document.getElementById('hint2v_' + idx);
    if (!h) return;
    h.textContent = msg;
    h.style.display = 'block';
    h.style.background = isError ? '#fff1f0' : '#fffbe6';
    h.style.borderColor = isError ? '#ffa39e' : '#ffe58f';
    h.style.color       = isError ? '#cf1322' : '#874d00';
}

function setHint2(msg) {
    var bar = document.getElementById('hintBar2');
    bar.textContent = msg;
    bar.style.background = '#fffbe6';
    bar.style.borderColor = '#ffe58f';
    bar.style.color = '#874d00';
    _setCardHint(msg, false);
}
function flashHint2(msg) {
    var bar = document.getElementById('hintBar2');
    bar.textContent = msg;
    bar.style.background = '#fff1f0';
    bar.style.borderColor = '#ffa39e';
    bar.style.color = '#cf1322';
    _setCardHint(msg, true);
}
