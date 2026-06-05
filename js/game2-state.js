// ════════════════════════════════════════════════════════
//  game2-state.js  全局状态 + 抗伤位管理
// ════════════════════════════════════════════════════════

// 抗伤位：hero队 玩家索引0或2；rebel队 玩家索引1或3
var G = {
    tankIdx:    { hero: 0, rebel: 1 }, // 当前各队抗伤位
    step:       0,       // 点击状态机：0=等待选己方手，1=等待选敌方手
    myHandIdx:  -1,      // 已选中的己方手索引
    myPlayerIdx:-1,      // 已选中的己方玩家索引
    wukongPending:   null, // 孙悟空[0,2]等待选目标暂存
    helpTankContext: null, // 帮抗弹窗上下文
    helpTankTimer:   null,
    inputLocked:     false, // 帮抗弹窗期间锁定前端点击
    stealTimer:    null,
    stealQueue:    [],
    cakeActorIdx: -1,
    cakeGroups:    1,
    cakeMaxGroups: 0,
};

// 玩家索引 → 队伍
function campOf(idx) { return (idx === 0 || idx === 2) ? 'hero' : 'rebel'; }

// ── 抗伤位切换 ──
function toggleTank(playerIdx, fromRemote) {
    var camp = campOf(playerIdx);
    if (G.tankIdx[camp] === playerIdx) return;
    // 联机：不能切换敌方抗伤位
    if (ONLINE.active && !fromRemote && camp !== ONLINE.myCamp()) return;
    G.tankIdx[camp] = playerIdx;
    updateTankButtons();
    if (!fromRemote) ONLINE.sendAction({ type: "toggleTank", playerIdx: playerIdx });
}

function updateTankButtons() {
    for (var i = 0; i < 4; i++) {
        var btn = document.getElementById('tankBtn' + i);
        if (!btn) continue;
        var active = G.tankIdx[campOf(i)] === i;
        btn.className = 'tank-btn' + (active ? ' active' : '');
        btn.title = active ? '当前抗伤位（点击无效）' : '点击设为抗伤位';
    }
}

// 根据攻击行为找到真实受击目标（考虑抗伤重定向）
function getActualTarget(intendedTargetIdx) {
    var players = Main.turnManager.players;
    var camp = campOf(intendedTargetIdx);
    var tankIdx = G.tankIdx[camp];
    if (players[tankIdx] && players[tankIdx].hp > 0) return tankIdx;
    // 抗伤位已死，找该队任意存活
    var seats = (camp === 'hero') ? [0, 2] : [1, 3];
    for (var i = 0; i < seats.length; i++) {
        if (players[seats[i]] && players[seats[i]].hp > 0) return seats[i];
    }
    return intendedTargetIdx;
}

// 找敌方任意存活玩家（用于合法性预检）
function findAnyEnemy(actorIdx) {
    var players = Main.turnManager.players;
    var ac = campOf(actorIdx);
    for (var i = 0; i < players.length; i++) {
        if (campOf(i) !== ac && players[i].hp > 0) return players[i];
    }
    return null;
}

// 找该玩家第一只非0的手索引
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
        // 护盾：清空后重建
        while (p.shieldList.length > 0) p.shieldList.pop();
        s.shields.forEach(function(sh) {
            p.shieldList.push({ type: sh.type, amount: sh.amount, duration: sh.duration });
        });
        // Buff：只恢复层数
        s.buffs.forEach(function(sb) {
            var ex = p.getBuff(sb.id);
            if (ex) ex.layers = sb.layers;
        });
    });
}

// ── 注入 tankResolver 到引擎 ──
// 在 startGame2 里调用，让 GameEngine.findEnemyTarget 也走抗伤位
function setupTankResolver() {
    Main.engine.constructor.tankResolver = function(actorIdx, defaultTargetIdx) {
        // actorIdx: 发起伤害的人（被动技能触发者）
        // defaultTargetIdx: 引擎找到的默认目标
        // 返回：实际应该受伤的目标idx（抗伤位）
        var players = Main.turnManager.players;
        var targetCamp = campOf(defaultTargetIdx);
        var tankIdx = G.tankIdx[targetCamp];
        if (players[tankIdx] && players[tankIdx].hp > 0) return tankIdx;
        // 抗伤位已死，找该队任意存活
        var seats = (targetCamp === 'hero') ? [0, 2] : [1, 3];
        for (var i = 0; i < seats.length; i++) {
            if (players[seats[i]] && players[seats[i]].hp > 0) return seats[i];
        }
        return defaultTargetIdx;
    };
}

// 游戏结束时清除 resolver（避免影响1v1）
function clearTankResolver() {
    Main.engine.constructor.tankResolver = null;
}
