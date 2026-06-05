// ════════════════════════════════════════════════════════
//  game2-state.js  全局状态 + 抗伤位 + 阵容管理
// ════════════════════════════════════════════════════════

var G = {
    tankIdx:    { hero: 0, rebel: 1 }, // 当前各队抗伤位/坦克索引
    formation:  { hero: 'dual_half', rebel: 'dual_half' }, // 'dual_half' | 'tank_carry'
    tankTarget: { hero: 'carry', rebel: 'carry' }, // 坦脆vs坦脆：坦克当前选择打谁 'carry'|'tank'
    step:       0,
    myHandIdx:  -1,
    myPlayerIdx:-1,
    wukongPending:   null,
    helpTankContext: null,
    helpTankTimer:   null,
    inputLocked:     false,
    stealTimer:    null,
    stealQueue:    [],
    cakeActorIdx: -1,
    cakeGroups:    1,
    cakeMaxGroups: 0,
};

function campOf(idx) { return (idx === 0 || idx === 2) ? 'hero' : 'rebel'; }

// 获取某队的脆皮索引（坦脆流用）
function getCarryIdx(camp) {
    var seats   = (camp === 'hero') ? [0, 2] : [1, 3];
    var tankIdx = G.tankIdx[camp];
    return seats[0] === tankIdx ? seats[1] : seats[0];
}

// ── 抗伤位切换（双半肉可切，坦脆流不可切） ──
function toggleTank(playerIdx, fromRemote) {
    var camp = campOf(playerIdx);
    if (G.tankIdx[camp] === playerIdx) return;
    // 坦脆流：抗伤位固定（等于坦克），不允许切换
    if (G.formation[camp] === 'tank_carry') return;
    // 联机：不能切换敌方
    if (ONLINE.active && !fromRemote && camp !== ONLINE.myCamp()) return;
    G.tankIdx[camp] = playerIdx;
    updateTankButtons();
    if (!fromRemote) ONLINE.sendAction({ type: "toggleTank", playerIdx: playerIdx });
}

function updateTankButtons() {
    for (var i = 0; i < 4; i++) {
        var btn = document.getElementById('tankBtn' + i);
        if (!btn) continue;
        var camp      = campOf(i);
        var active    = G.tankIdx[camp] === i;
        var isTankCarry = G.formation[camp] === 'tank_carry';
        // 坦脆流：显示"坦克"或"脆皮"标签，不可点
        if (isTankCarry) {
            var isTank = G.tankIdx[camp] === i;
            btn.textContent = isTank ? '🏰 坦克' : '⚔️ 脆皮';
            btn.className   = 'tank-btn' + (isTank ? ' active tank-fixed' : ' carry-fixed');
            btn.title       = isTank ? '坦克（固定抗伤）' : '脆皮';
        } else {
            btn.textContent = '🛡 抗伤';
            btn.className   = 'tank-btn' + (active ? ' active' : '');
            btn.title       = active ? '当前抗伤位（点击无效）' : '点击设为抗伤位';
        }
    }
    // 更新坦克攻击目标按钮（坦脆vs坦脆）
    updateTankTargetButtons();
}

// 坦克攻击目标按钮（仅坦脆流坦克行动时显示）
function updateTankTargetButtons() {
    for (var i = 0; i < 4; i++) {
        var area = document.getElementById('tankTargetArea' + i);
        if (!area) continue;
        var players = Main.turnManager ? Main.turnManager.players : null;
        if (!players) { area.innerHTML = ''; continue; }

        var camp      = campOf(i);
        var enemyCamp = camp === 'hero' ? 'rebel' : 'hero';
        var isTank    = G.formation[camp] === 'tank_carry' && G.tankIdx[camp] === i;
        var curIdx    = Main.turnManager.currentPlayerIdx;
        var enemyIsTankCarry = G.formation[enemyCamp] === 'tank_carry';

        // 只在：我是坦克 + 敌方也是坦脆流 + 当前轮到我 时显示
        if (!isTank || !enemyIsTankCarry || i !== curIdx) {
            area.innerHTML = '';
            continue;
        }

        var tankIdx  = G.tankIdx[enemyCamp];
        var carryIdx = getCarryIdx(enemyCamp);
        var tankName  = players[tankIdx]  && players[tankIdx].hp  > 0 ? players[tankIdx].name  : null;
        var carryName = players[carryIdx] && players[carryIdx].hp > 0 ? players[carryIdx].name : null;

        var cur = G.tankTarget[camp];
        var html = '<div style="font-size:11px;color:#888;margin-bottom:3px">攻击目标：</div>';
        if (carryName) {
            html += '<button onclick="setTankTarget(\'' + camp + '\',\'carry\')" ' +
                'class="tank-target-btn' + (cur==='carry' ? ' active' : '') + '">' +
                '⚔️ ' + carryName + '</button> ';
        }
        if (tankName) {
            html += '<button onclick="setTankTarget(\'' + camp + '\',\'tank\')" ' +
                'class="tank-target-btn' + (cur==='tank' ? ' active' : '') + '">' +
                '🏰 ' + tankName + '</button>';
        }
        area.innerHTML = html;
    }
}

function setTankTarget(camp, target) {
    // 联机：只能设置本方
    if (ONLINE.active && camp !== ONLINE.myCamp()) return;
    G.tankTarget[camp] = target;
    updateTankTargetButtons();
}

// ── 核心：根据阵容规则获取实际受伤目标 ──
// bypassTankRule=true 时豁免（孙悟空[0,2]、藏师蛋糕等）
function getActualTarget(intendedTargetIdx, bypassTankRule) {
    if (bypassTankRule) return intendedTargetIdx;

    var players      = Main.turnManager.players;
    var defCamp      = campOf(intendedTargetIdx);
    var attackerIdx  = Main.turnManager.currentPlayerIdx;
    var atkCamp      = campOf(attackerIdx);
    var atkFormation = G.formation[atkCamp];
    var defFormation = G.formation[defCamp];
    var atkIsTank    = atkFormation === 'tank_carry' && G.tankIdx[atkCamp] === attackerIdx;

    // ── 坦脆流坦克：可以自由选目标（通过 tankTarget 按钮） ──
    if (atkFormation === 'tank_carry' && atkIsTank && defFormation === 'tank_carry') {
        var sel = G.tankTarget[atkCamp];
        var tgt = sel === 'carry' ? getCarryIdx(defCamp) : G.tankIdx[defCamp];
        // 目标死了就打另一个
        if (players[tgt] && players[tgt].hp > 0) return tgt;
        // 目标死了，打存活的
        var alt = sel === 'carry' ? G.tankIdx[defCamp] : getCarryIdx(defCamp);
        if (players[alt] && players[alt].hp > 0) return alt;
    }

    // ── 坦脆流脆皮：只能打对方坦克（坦克死了才能打脆皮） ──
    if (atkFormation === 'tank_carry' && !atkIsTank) {
        var defTankIdx = G.tankIdx[defCamp];
        if (players[defTankIdx] && players[defTankIdx].hp > 0) {
            return defTankIdx; // 坦克存活，必须打坦克
        }
        // 坦克已死，打对方存活的
        var seats = defCamp === 'hero' ? [0,2] : [1,3];
        for (var i = 0; i < seats.length; i++) {
            if (players[seats[i]] && players[seats[i]].hp > 0) return seats[i];
        }
    }

    // ── 双半肉 vs 任意 / 坦脆坦克 vs 双半肉：打对方抗伤位/坦克 ──
    var tankIdx = G.tankIdx[defCamp];
    if (players[tankIdx] && players[tankIdx].hp > 0) return tankIdx;
    // 抗伤位已死，找该队任意存活
    var fallbackSeats = defCamp === 'hero' ? [0,2] : [1,3];
    for (var j = 0; j < fallbackSeats.length; j++) {
        if (players[fallbackSeats[j]] && players[fallbackSeats[j]].hp > 0) return fallbackSeats[j];
    }
    return intendedTargetIdx;
}

function findAnyEnemy(actorIdx) {
    var players = Main.turnManager.players;
    var ac = campOf(actorIdx);
    for (var i = 0; i < players.length; i++) {
        if (campOf(i) !== ac && players[i].hp > 0) return players[i];
    }
    return null;
}

function findNonZeroHand(player) {
    if (player.hands[0] !== 0) return 0;
    if (player.hands[1] !== 0) return 1;
    return -1;
}

// ── 快照 / 回滚 ──
function takeSnapshot(idxList) {
    var players = Main.turnManager.players;
    var snap = {};
    idxList.forEach(function(idx) {
        var p = players[idx];
        snap[idx] = {
            hp: p.hp,
            hands: [p.hands[0], p.hands[1]],
            zeroTurns0: p.zeroTurns0, zeroTurns1: p.zeroTurns1,
            pendingHealing: p.pendingHealing,
            shields: p.shieldList.map(function(s) {
                return { type: s.type, amount: s.amount, duration: s.duration };
            }),
            buffs: p.buffList.map(function(b) {
                return { id: b.id, name: b.name, layers: b.layers };
            }),
        };
    });
    return snap;
}

function restoreSnapshot(snap) {
    var players = Main.turnManager.players;
    Object.keys(snap).forEach(function(key) {
        var idx = parseInt(key);
        var p = players[idx];
        var s = snap[idx];
        p.hp = s.hp;
        p.hands[0] = s.hands[0]; p.hands[1] = s.hands[1];
        p.zeroTurns0 = s.zeroTurns0; p.zeroTurns1 = s.zeroTurns1;
        p.pendingHealing = s.pendingHealing;
        while (p.shieldList.length > 0) p.shieldList.pop();
        s.shields.forEach(function(sh) {
            p.shieldList.push({ type: sh.type, amount: sh.amount, duration: sh.duration });
        });
        s.buffs.forEach(function(sb) {
            var ex = p.getBuff(sb.id);
            if (ex) ex.layers = sb.layers;
        });
    });
}

function setupTankResolver() {
    // 注意：GameEngine 被 Haxe IIFE 包裹，外部无法直接访问其静态变量。
    // 必须通过 Main.setTankResolver() 这个 @:keep 暴露的方法来设置。
    var fn = function(actorIdx, defaultTargetIdx) {
        var players    = Main.turnManager.players;
        var targetCamp = campOf(defaultTargetIdx);
        var tankIdx    = G.tankIdx[targetCamp];
        if (players[tankIdx] && players[tankIdx].hp > 0) return tankIdx;
        var seats = (targetCamp === 'hero') ? [0,2] : [1,3];
        for (var i = 0; i < seats.length; i++) {
            if (players[seats[i]] && players[seats[i]].hp > 0) return seats[i];
        }
        return defaultTargetIdx;
    };
    Main.setTankResolver(fn);
}

function clearTankResolver() {
    Main.setTankResolver(null);
}
