// ════════════════════════════════════════════════════════════════════
//  game2-ai.js  v3
//  模块职责：
//    AI          — 对外接口、初始化、checkAndAct 入口
//    AI.score    — 启发式打分（权重驱动，支持热更新）
//    AI.decide   — 主动技能 / 抗伤位决策
//    AI.helpTank — 自动帮抗判断
//    AI.llm      — LLM 调用层
//    AI.train    — 自战训练系统（角色选择 + 持续对战 + 复盘更新权重）
// ════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────
//  默认权重（从文件加载后会覆盖这里）
// ──────────────────────────────────────────────────
var AI_DEFAULT_WEIGHTS = {
    // 双子星（按价值从高到低调权重，[2,2]/[3,3] 设负值主动回避）
    star_0:  150, star_9: 120, star_7:  85, star_6:  75,
    star_1:   50, star_4:  50, star_5:  45, star_8:  40,
    star_2:  -25, star_3: -25,   // 低收益双子星 → 主动回避

    // 0 组合（按角色效果打分，全部正向）
    zero_combo_atk: 95,  // [0,1/5/8/9] 攻击
    zero_combo_heal: 60, // [0,4/6] 回血
    zero_combo_7:   40,  // [0,7] 毒
    zero_combo_shield: 30, // [0,2/3] 护盾

    // 凑 0 的激励（另一只手 >0 时才给分）
    build_zero: 60,

    // 单手 6 回血
    six_heal: 20,

    // 帮助对方凑双子星的惩罚
    give_star_9: -70,  give_star_7: -55,
    give_star_0: -130, give_star_other: -18,

    // 帮对方完成 0 组合的惩罚
    give_zero_combo: -45,

    // 击杀奖励
    kill_bonus: 95,

    // 路径深度激励（能在 N 步内凑成高价值组合则加分）
    path_bonus: 35,

    // 角色专属
    mage_zero_atk:    70,  // 法师 0 组合强制最高优先
    wukong_02:       145,  // 悟空 [0,2]
    ninja_7:          35,  // 忍者凑 7
    zhangfei_diff:   1.8,  // 张飞双手差值每点加分
    daqiao_evolve:    40,  // 大乔冲进化
};

// ──────────────────────────────────────────────────
//  主对象
// ──────────────────────────────────────────────────
window.AI = {
    enabled:       false,
    aiCamp:        'rebel',
    controlled:    {},          // { playerIdx: true }
    knowledgeCache: null,
    skillCache:    {},
    thinkingPromise: null,
    log:           [],
    providerMap:   {},
    weights:       Object.assign({}, AI_DEFAULT_WEIGHTS),
};

// ──────────────────────────────────────────────────
//  初始化接口
// ──────────────────────────────────────────────────
AI.start = function(aiCamp) {
    AI.enabled  = true;
    AI.aiCamp   = aiCamp || 'rebel';
    AI.log      = [];
    AI.controlled = {};
    AI.providerMap = {};
    const seats = aiCamp === 'rebel' ? [1, 3] : [0, 2];
    seats.forEach(s => { AI.controlled[s] = true; });
    AI.providerMap[seats[0]] = 'minimax';
    AI.providerMap[seats[1]] = 'deepseek';
    AI.loadWeights();
    AI.loadKnowledge();
};

AI.refreshControlled = function() {
    if (!window.ONLINE || !ONLINE.active) return;
    AI.controlled = {};
    let anyAI = false;
    for (let i = 0; i < 4; i++) {
        if (ONLINE.charControl[i] === 'AI') {
            AI.controlled[i] = true;
            anyAI = true;
        }
    }
    if (anyAI && !AI.enabled) {
        AI.enabled = true;
        Object.keys(AI.controlled).forEach((p, k) => {
            AI.providerMap[p] = k % 2 === 0 ? 'minimax' : 'deepseek';
        });
        AI.loadWeights();
        if (!AI.knowledgeCache) AI.loadKnowledge();
    }
};

AI.stop = function() { AI.enabled = false; AI.thinkingPromise = null; };

// ──────────────────────────────────────────────────
//  权重与知识库 I/O
// ──────────────────────────────────────────────────
AI.loadWeights = async function() {
    try {
        const r = await fetch('/api/weights');
        if (r.ok) {
            const w = await r.json();
            Object.assign(AI.weights, w);
            console.log('[AI] 权重已加载', AI.weights);
        }
    } catch(e) { console.warn('[AI] 权重加载失败，使用默认值'); }
};

AI.saveWeights = async function() {
    try {
        await fetch('/api/weights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(AI.weights),
        });
        console.log('[AI] 权重已保存');
    } catch(e) { console.warn('[AI] 权重保存失败', e); }
};

AI.loadKnowledge = async function() {
    try {
        const r = await fetch('/api/knowledge');
        AI.knowledgeCache = await r.text();
    } catch(e) { AI.knowledgeCache = ''; }
};

AI.loadSkill = async function(name) {
    if (AI.skillCache[name]) return AI.skillCache[name];
    try {
        const r = await fetch('/api/skill?name=' + encodeURIComponent(name));
        AI.skillCache[name] = await r.text();
        return AI.skillCache[name];
    } catch(e) { return ''; }
};

// ──────────────────────────────────────────────────
//  checkAndAct — render2 后调用
// ──────────────────────────────────────────────────
AI.checkAndAct = function() {
    if (!AI.enabled || AI.thinkingPromise) return;
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    if (G.inputLocked || G.helpTankContext || G.wukongPending) return;
    const curIdx = Main.turnManager.currentPlayerIdx;
    const isAI = Object.keys(AI.controlled).length > 0
        ? !!AI.controlled[curIdx]
        : campOf(curIdx) === AI.aiCamp;
    if (!isAI) return;
    AI.thinkingPromise = AI.takeTurn(curIdx).finally(() => { AI.thinkingPromise = null; });
};

// ──────────────────────────────────────────────────
//  AI 主回合流程
// ──────────────────────────────────────────────────
AI.takeTurn = async function(actorIdx) {
    const players = Main.turnManager.players;
    const actor   = players[actorIdx];
    setHint2('🤖 ' + actor.name + ' 思考中...');

    // 1. 主动技能 + 抗伤位决策
    AI.decide.activeSkills(actorIdx);
    AI.decide.tankPosition(actorIdx);

    // 2. 枚举合法动作
    const candidates = AI.enumerateLegalActions(actorIdx);
    if (candidates.length === 0) { finishTurn2(); return; }

    // 3. 启发式打分（含 lookahead），取 top-4
    candidates.forEach(c => { c.score = AI.score.evaluate(actorIdx, c); });
    candidates.sort((a, b) => b.score - a.score);
    const top4 = candidates.slice(0, 4);

    // 4. 帮抗 AI 自动决策（自战时用，玩家对战时弹窗仍然弹）
    // （帮抗弹窗由 tryHelpTankOrPause 负责，这里不干预）

    // 5. 加载角色技能文档
    const skillDoc = await AI.loadSkill(actor.name);

    // 6. LLM 决策（15% 概率探索）
    let chosen = top4[0];
    let reason = '启发式';

    if (Math.random() < 0.15 && top4.length > 1) {
        const pick = 1 + Math.floor(Math.random() * Math.min(2, top4.length - 1));
        chosen = top4[pick];
        reason = `探索(#${pick})`;
    } else {
        try {
            const provider = AI.providerMap[actorIdx] || 'minimax';
            const result   = await AI.llm.ask(actorIdx, top4, skillDoc, provider);
            if (result && typeof result.choice === 'number') {
                const idx = Math.max(0, Math.min(top4.length - 1, result.choice));
                chosen = top4[idx];
                reason = `[${provider}] ${result.reason || ''}`;
            }
        } catch(e) {
            console.warn('[AI] LLM failed:', e);
        }
    }

    AI.log.push({ turn: Main.turnManager.turnCount, actor: actor.name, reason, score: chosen.score });
    setHint2('🤖 ' + actor.name + ': ' + reason.slice(0, 35));

    const dmgTargetIdx = getActualTarget(chosen.targetIdx);
    doAttack2(actorIdx, chosen.myHand, chosen.targetIdx, chosen.touchHandIdx, dmgTargetIdx);
};

// ──────────────────────────────────────────────────
//  枚举合法动作
// ──────────────────────────────────────────────────
AI.enumerateLegalActions = function(actorIdx) {
    const players = Main.turnManager.players;
    const actor   = players[actorIdx];
    const result  = [];
    for (let tIdx = 0; tIdx < players.length; tIdx++) {
        if (campOf(tIdx) === campOf(actorIdx)) continue;
        const tp = players[tIdx];
        if (!tp || tp.hp <= 0) continue;
        for (let myHand = 0; myHand < 2; myHand++) {
            for (let tHand = 0; tHand < 2; tHand++) {
                if (tp.hands[tHand] === 0) continue;
                const valid = !actor.isValidTouch || actor.isValidTouch(myHand, tp, tHand);
                if (valid) result.push({ myHand, targetIdx: tIdx, touchHandIdx: tHand });
            }
        }
    }
    return result;
};

// ══════════════════════════════════════════════════
//  AI.score — 打分模块
// ══════════════════════════════════════════════════
AI.score = {};

AI.score.evaluate = function(actorIdx, action) {
    return AI.score.heuristic(actorIdx, action) + AI.score.lookahead(actorIdx, action);
};

AI.score.heuristic = function(actorIdx, action) {
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const target   = players[action.targetIdx];
    if (!target) return 0;

    const W        = AI.weights;
    const myVal    = actor.hands[action.myHand];
    const tVal     = target.hands[action.touchHandIdx];
    const newVal   = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    const hpR      = actor.hp / (actor.maxHp || 1);
    let score      = 0;

    // ── 双子星（用权重表，低价值双子星为负）──
    if (newVal === otherVal && newVal > 0) {
        score += W['star_' + newVal] !== undefined ? W['star_' + newVal] : 15;
    }

    // ── 凑 0 ──
    if (newVal === 0 && otherVal > 0) score += W.build_zero;
    if (newVal === 0 && otherVal === 0) score -= 999; // 双零

    // ── 完成 [0,x] 组合 ──
    if (otherVal === 0 && newVal > 0) {
        if ([1,5,8,9].includes(newVal)) score += W.zero_combo_atk;
        else if ([4,6].includes(newVal)) {
            const healBonus = hpR < 0.5 ? W.zero_combo_heal * 1.3 : W.zero_combo_heal;
            score += healBonus;
        }
        else if (newVal === 7) score += W.zero_combo_7;
        else if ([2,3].includes(newVal)) score += W.zero_combo_shield;
        // 法师加算
        if (actor.name === '法师' && [1,5,8,9].includes(newVal)) score += W.mage_zero_atk;
    }

    // ── 0 倒计时压力（快到了就用，不惩罚持有 0）──
    if (myVal === 0) {
        const myZT = action.myHand === 0 ? actor.zeroTurns0 : actor.zeroTurns1;
        if (myZT <= 1) score += 30; // 倒计时快到了必须动这手
    }

    // ── [x,6] 单手 6 回血 ──
    if (newVal === 6 && otherVal !== 6) {
        const healBonus = hpR < 0.4 ? W.six_heal * 2.0 : (hpR < 0.65 ? W.six_heal * 1.2 : W.six_heal * 0.5);
        score += healBonus;
        if (actor.name === '法师') score -= 30; // 法师不需要回血
    }

    // ── 路径激励：距离高价值双子星差值为 1（布局中间态）──
    // 但仅对高价值双子星有效，避免刷 [2,2]/[3,3] 路径
    if (Math.abs(newVal - otherVal) === 1 && newVal > 0 && otherVal > 0) {
        const targetStar = Math.min(newVal, otherVal) + 1; // 需要凑的数字
        if ([9,7,6,0,1,4,5,8].includes(targetStar)) score += 8;
        // [2,3] 路径不给路径分
    }

    // ── 角色专属 ──
    switch (actor.name) {
        case '孙悟空':
            if ((newVal===0&&otherVal===2)||(newVal===2&&otherVal===0)) {
                if ((actor.zeroTwoUses||0) < 3) score += W.wukong_02;
            }
            break;
        case '忍者':
            if (newVal === 7 || otherVal === 7) score += W.ninja_7;
            if (newVal === 7 && otherVal === 7) score += W.ninja_7;
            break;
        case '张飞':
            score += Math.abs(newVal - otherVal) * W.zhangfei_diff;
            break;
        case '大乔':
            // 冲进化
            if (actor.hp > 240 && actor.hp < 310 && otherVal===0 && [1,5,8,9].includes(newVal))
                score += W.daqiao_evolve;
            break;
        case '鸦眼':
            const hasCrow = (target.buffList||[]).some(b=>b.id==='CROW'&&b.layers>0);
            if (hasCrow) score += 50;
            break;
    }

    // ── 激进/保守调节 ──
    const tHpR = target.hp / (target.maxHp || 1);
    if (hpR > 0.7 && tHpR < 0.3) score += 15; // 我血厚对方快死 → 激进

    return score;
};

AI.score.lookahead = function(actorIdx, action) {
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const target   = players[action.targetIdx];
    const W        = AI.weights;
    const dmgIdx   = typeof getActualTarget === 'function' ? getActualTarget(action.targetIdx) : action.targetIdx;
    const dmgTarget = players[dmgIdx];
    if (!dmgTarget) return 0;

    const myVal    = actor.hands[action.myHand];
    const tVal     = target.hands[action.touchHandIdx];
    const newVal   = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    let bonus      = 0;

    // 估算输出伤害
    let estDmg = 0;
    if (otherVal === 0 && newVal > 0) {
        estDmg = {1:40,5:40,8:40,9:40,7:10}[newVal] || 0;
    }
    if (newVal === otherVal && newVal > 0) {
        estDmg = Math.max(estDmg, {9:200,0:150,7:40}[newVal] || 0);
    }
    // 角色倍率修正
    if (actor.name==='小乔') estDmg = Math.floor(estDmg * 1.5);
    if (actor.name==='法师' && otherVal===0 && [1,5,8,9].includes(newVal)) estDmg += 45;

    const shTotal = (dmgTarget.shieldList||[]).reduce((s,x) => s+(x.amount||0), 0);
    bonus += Math.max(0, estDmg - shTotal) * 0.5;

    // 击杀奖励
    if (estDmg > 0 && estDmg >= dmgTarget.hp) {
        bonus += W.kill_bonus;
        if ((dmgTarget.maxHp||999) < 200) bonus += 20; // 脆皮优先击杀
    }

    // 我动完后对方双手的危险度（帮对方凑组合 → 惩罚）
    const tOther  = target.hands[1 - action.touchHandIdx];
    const tNewVal = (target.hands[action.touchHandIdx] + myVal) % 10; // 对方该手被碰后的值
    // 注意：我碰对方，变的是我自己的手，对方的手不变。所以这里其实是：对方被碰的手不变，但我们看我动完之后对方两手是否凑成危险组合
    // 实际上对方被碰后手不变，要看对方另一手配合被碰手是否危险
    if (tNewVal === tOther && tNewVal > 0) {
        // 帮对方凑了双子星
        const penalty = W['give_star_' + tNewVal] !== undefined
            ? W['give_star_' + tNewVal]
            : W.give_star_other;
        bonus += penalty;
    }
    if (tNewVal === 0 && tOther > 0) bonus += W.give_zero_combo; // 帮对方凑 0
    if (tOther === 0 && [1,5,8,9].includes(tNewVal)) bonus += W.give_zero_combo; // 帮对方完成攻击 0 组合

    // 路径激励（2 步内能凑高价值双子星 → 加分）
    const nextOther = newVal; // 动完后我的这手 = newVal
    const curOther  = otherVal;
    // 两手差值为 0 但上面已经算了双子星，差值为 1 → 下回合可能凑成
    const diff = Math.abs(nextOther - curOther);
    if (diff === 1 && nextOther > 0 && curOther > 0) {
        const target2 = Math.max(nextOther, curOther); // 下次要凑的值
        if ([9,7,6,1,4,5,8].includes(target2)) bonus += W.path_bonus;
    }

    return bonus;
};

// ══════════════════════════════════════════════════
//  AI.decide — 主动技能 / 抗伤位决策
// ══════════════════════════════════════════════════
AI.decide = {};

AI.decide.activeSkills = function(actorIdx) {
    const players = Main.turnManager.players;
    const actor   = players[actorIdx];
    const hpR     = actor.hp / (actor.maxHp || 1);
    const name    = actor.name;

    if (name === '鸦眼') {
        // 灼燃箭：只要血量够就开启
        if (!actor.useBurningArrow && actor.hp > 70)
            Main.invokeAction(actorIdx, 'toggleBurningArrow', {});
        // 魔王剑：乌鸦够6且灼燃开启且血量充足
        if (actor.useBurningArrow && actor.crowCount >= 6 && actor.hp > 180 && !actor.useDemonSword)
            Main.invokeAction(actorIdx, 'toggleDemonSword', {});
        // 乌鸦诅咒：敌方没有乌鸦buff时主动施加（走 invokeAction 而非弹窗，因为自战时弹窗无人点）
        const enemies = players.filter((p,i) => campOf(i) !== campOf(actorIdx) && p.hp > 0);
        const enemyHasCrow = enemies.some(p => (p.buffList||[]).some(b=>b.id==='CROW'&&b.layers>0));
        if (!enemyHasCrow && actor.hp > 50)
            Main.invokeAction(actorIdx, 'crowCurseTarget', { camp: 'enemy' });
    }

    if (name === '张飞') {
        const enemies = players.filter((p,i) => campOf(i) !== campOf(actorIdx) && p.hp > 0);
        const modal   = actor.modal || 1;
        // 血量低于45% → 模态3（打人回血）
        if (hpR < 0.45 && modal !== 3)
            Main.invokeAction(actorIdx, 'setModal', { modal: 3 });
        // 2v2 两个敌人都活着 → 模态2（打两人）
        else if (enemies.length >= 2 && modal !== 2 && hpR >= 0.45)
            Main.invokeAction(actorIdx, 'setModal', { modal: 2 });
        // 默认模态1
        else if (enemies.length < 2 && hpR >= 0.45 && modal !== 1)
            Main.invokeAction(actorIdx, 'setModal', { modal: 1 });
    }

    if (name === '阴阳师') {
        const modal = actor.modal || 'ren';
        // 血量低于45% → 阳（回血）
        if (hpR < 0.45 && modal !== 'yang')
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'yang' });
        // 血量高于60% → 阴（输出）
        else if (hpR > 0.60 && modal !== 'yin')
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'yin' });
        // 中间区间 → 人（均衡）
        else if (hpR >= 0.45 && hpR <= 0.60 && modal !== 'ren')
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'ren' });
    }

    // 大乔进化
    if (name === '大乔' && actor.hp > 300 && !actor.evolved) {
        Main.invokeAction(actorIdx, 'evolve', {});
    }
};

// 抗伤位决策：有盾优先抗，都没盾血多抗，血太低不能抗
AI.decide.tankPosition = function(actorIdx) {
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const camp     = campOf(actorIdx);
    if (!G || G.formation[camp] !== 'dual_half') return; // 只有双半肉才切抗伤位

    const seats    = camp === 'hero' ? [0, 2] : [1, 3];
    const alive    = seats.filter(i => players[i] && players[i].hp > 0);
    if (alive.length < 2) return; // 只剩一人，无需切换

    const [a, b]   = alive;
    const pa       = players[a];
    const pb       = players[b];
    const shieldA  = (pa.shieldList||[]).reduce((s,x)=>s+(x.amount||0),0);
    const shieldB  = (pb.shieldList||[]).reduce((s,x)=>s+(x.amount||0),0);
    const hpRatioA = pa.hp / (pa.maxHp||1);
    const hpRatioB = pb.hp / (pb.maxHp||1);

    let preferTank = G.tankIdx[camp]; // 默认不换

    // 规则 1：有盾的优先抗（盾多的优先）
    if (shieldA > shieldB + 10) preferTank = a;
    else if (shieldB > shieldA + 10) preferTank = b;
    // 规则 2：都没盾 → 血量比例高的抗
    else if (Math.abs(shieldA - shieldB) <= 10) {
        preferTank = hpRatioA >= hpRatioB ? a : b;
    }

    // 规则 3：当前抗伤位血量 < 25% → 强制换人（不管盾）
    const curTank = G.tankIdx[camp];
    const curTankHP = players[curTank] && players[curTank].hp / (players[curTank].maxHp||1);
    if (curTankHP < 0.25) {
        const other = alive.find(i => i !== curTank);
        if (other !== undefined) preferTank = other;
    }

    if (preferTank !== G.tankIdx[camp]) {
        toggleTank(preferTank);
    }
};

// ══════════════════════════════════════════════════
//  AI.helpTank — 自战时自动帮抗
//  （玩家对战时依然弹窗，这里只在 AI 控制双方时被调用）
// ══════════════════════════════════════════════════
AI.helpTank = {};

// 返回 true 表示 AI 决定帮抗
AI.helpTank.decide = function(helperIdx, victimIdx, totalPenalty) {
    const players = Main.turnManager.players;
    const helper  = players[helperIdx];
    const victim  = players[victimIdx];
    if (!helper || helper.hp <= 0) return false;

    // 帮抗后自己不死
    if (totalPenalty >= helper.hp) return false;

    // 队友价值评估：血量 + buff 层数
    const victimValue = (victim.hp / (victim.maxHp||1)) * 100
        + (victim.buffList||[]).filter(b=>b.layers>0).length * 15;

    // 自己血量
    const helperHpR = helper.hp / (helper.maxHp||1);

    // 己方是否占优（总HP）
    const camp      = campOf(helperIdx);
    const seats     = camp === 'hero' ? [0,2] : [1,3];
    const myTotalHP = seats.reduce((s,i) => s + (players[i]?.hp||0), 0);
    const enemySeats = camp === 'hero' ? [1,3] : [0,2];
    const enTotalHP  = enemySeats.reduce((s,i) => s + (players[i]?.hp||0), 0);
    const winning    = myTotalHP > enTotalHP * 1.2;

    // 帮抗条件：
    // 1. 帮完自己还能活（已在上面判断）
    // 2. 队友价值足够高（>30）
    // 3. 或者己方占优 → 更倾向帮
    if (victimValue > 30 || winning) return true;
    if (helperHpR > 0.6) return true; // 自己血够厚，帮一下

    return false;
};

// ══════════════════════════════════════════════════
//  AI.llm — LLM 调用层
// ══════════════════════════════════════════════════
AI.llm = {};

AI.llm.ask = async function(actorIdx, top4, skillDoc, provider) {
    if (!AI.knowledgeCache) await AI.loadKnowledge();
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const snapshot = AI.llm.buildSnapshot(actorIdx);

    const candidatesText = top4.map((c, i) => {
        const t = players[c.targetIdx];
        return `${i}: 我的${c.myHand===0?'左':'右'}手(${actor.hands[c.myHand]}) → 碰 ${t.name} 的${c.touchHandIdx===0?'左':'右'}手(${t.hands[c.touchHandIdx]}) [启发式${c.score.toFixed(0)}分]`;
    }).join('\n');

    const sysPrompt =
`你是指尖博弈AI，控制${actor.name}。从候选动作选最优一个。
严格JSON回复：{"choice":编号0-${top4.length-1},"reason":"15字内"}
注意：[2,2]/[3,3]双子星收益极低，避免为其布局；[0,x]组合和高价值双子星([9,9][7,7][6,6])优先。

【经验库】\n${(AI.knowledgeCache||'').slice(0, 800)}
${skillDoc ? `\n【${actor.name}专属攻略】\n${skillDoc.slice(0, 600)}` : ''}`;

    const userPrompt = `【局面】\n${snapshot}\n\n【候选动作】\n${candidatesText}\n\n选择：`;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider,
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user',   content: userPrompt },
                ],
                temperature: 0.3,
                max_tokens:  100,
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data    = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const m       = content.match(/\{[\s\S]*?\}/);
        if (m) return JSON.parse(m[0]);
        return null;
    } catch(e) {
        clearTimeout(timer);
        throw e;
    }
};

AI.llm.buildSnapshot = function(actorIdx) {
    const players = Main.turnManager.players;
    const lines   = [`回合:${Main.turnManager.turnCount} 行动:${players[actorIdx].name}`];
    players.forEach((p, i) => {
        const tag   = i===actorIdx?'【我】': campOf(i)===campOf(actorIdx)?'友':'敌';
        const buffs = (p.buffList||[]).filter(b=>b.layers>0).map(b=>b.name).join(',') || '无';
        const sh    = (p.shieldList||[]).reduce((a,b)=>a+b.amount,0);
        lines.push(`${tag}${p.name} HP:${p.hp} 手:[${p.hands}] 盾:${sh} Buff:${buffs}`);
    });
    return lines.join('\n');
};

// ══════════════════════════════════════════════════
//  AI.train — 自战训练系统
// ══════════════════════════════════════════════════
AI.train = {
    running:    false,
    battleCount: 0,
    stats:      { minimax: { win:0, lose:0 }, deepseek: { win:0, lose:0 } },
    onUpdate:   null,  // 外部注册回调，用于刷新训练面板 UI
};

// 角色ID → 名字映射（与 CharacterRegistry 对应）
const CHAR_ID_MAP = {
    'xiaoqiao':  '小乔',   'zangshi':   '藏师',
    'fashi':     '法师',   'sunwukong': '孙悟空',
    'daqiao':    '大乔',   'renzhe':    '忍者',
    'zhangfei':  '张飞',   'yinyangshi':'阴阳师',
    'yayan':     '鸦眼',
};
const CHAR_NAME_MAP = Object.fromEntries(Object.entries(CHAR_ID_MAP).map(([k,v])=>[v,k]));

// 所有可训练角色 ID（排除杨大力）
const TRAINABLE_CHARS = Object.keys(CHAR_ID_MAP);

// 坦克角色
const TANK_IDS = ['zangshi', 'zhangfei'];

// 按角色 ID 决定阵容类型
function decideFormation(charIds) {
    return charIds.some(id => TANK_IDS.includes(id)) ? 'tank_carry' : 'dual_half';
}

// 随机选 4 个角色（上局用过的不选，实在没得选才允许重复）
AI.train.pickChars = function(lastChars) {
    const pool = lastChars
        ? TRAINABLE_CHARS.filter(c => !lastChars.includes(c))
        : TRAINABLE_CHARS;
    const src  = pool.length >= 4 ? pool : TRAINABLE_CHARS;
    const shuffled = src.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 4);
};

AI.train.start = async function() {
    if (AI.train.running) return;
    AI.train.running    = true;
    AI.train.battleCount = 0;
    await AI.loadWeights();
    await AI.loadKnowledge();

    let lastChars = null;
    while (AI.train.running) {
        const chars = AI.train.pickChars(lastChars);
        lastChars   = chars;
        AI.train._lastChars = chars;
        await AI.train.runOneBattle(chars);
        AI.train.battleCount++;
        if (AI.train.onUpdate) AI.train.onUpdate();
        // 每 5 局保存权重和知识库
        if (AI.train.battleCount % 5 === 0) await AI.saveWeights();
        await new Promise(r => setTimeout(r, 800)); // 局间间隔
    }
};

AI.train.stop = async function() {
    AI.train.running = false;
    await AI.saveWeights();
    console.log('[Train] 训练停止，权重已保存');
};

AI.train.runOneBattle = function(charIds) {
    return new Promise(resolve => {
        // ── 完整初始化，对齐 startGame2() ──
        if (typeof setupTrace2v2 === 'function') setupTrace2v2();
        // 重置上局残留状态
        if (typeof clearTankResolver === 'function') clearTankResolver();
        if (typeof resetAvatars === 'function') resetAvatars(); // 正确重置头像守卫
        clearInterval(G.stealTimer || 0);
        G.stealQueue = [];
        window._stealUsedThisTurn = {}; // 重置大乔抢血冷却
        G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;

        const lp = document.getElementById('logPanel2');
        if (lp) lp.innerHTML = '';

        Main.setupGame2v2(charIds[0], charIds[1], charIds[2], charIds[3]);

        // 阵容
        const heroFormation  = decideFormation([charIds[0], charIds[2]]);
        const rebelFormation = decideFormation([charIds[1], charIds[3]]);
        G.formation = { hero: heroFormation, rebel: rebelFormation };
        G.tankIdx   = { hero: 0, rebel: 1 };
        G.tankIdx.hero  = TANK_IDS.includes(charIds[0]) ? 0 : (TANK_IDS.includes(charIds[2]) ? 2 : 0);
        G.tankIdx.rebel = TANK_IDS.includes(charIds[1]) ? 1 : (TANK_IDS.includes(charIds[3]) ? 3 : 1);

        if (typeof setupTankResolver === 'function') setupTankResolver();
        G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;

        AI.enabled    = true;
        AI.controlled = { 0:true, 1:true, 2:true, 3:true };
        AI.providerMap = { 0:'minimax', 2:'minimax', 1:'deepseek', 3:'deepseek' };
        AI.log        = [];

        document.getElementById('battleArena2').style.display  = 'block';
        document.getElementById('setupPanel2').style.display   = 'none';
        render2(); refreshHandStyles2(); updateTankButtons();

        // 注入帮抗自动决策：覆盖弹窗为 AI 自动判断
        const origShow = window.showHelpTankDialog;
        window.showHelpTankDialog = function(helperIdx, victimIdx) {
            const log  = Main.engine.lastTouchDamageLog || [];
            const pen  = log.reduce((s,l) => s + Math.ceil(l.outputAmount*1.5), 0);
            const doHelp = AI.helpTank.decide(helperIdx, victimIdx, pen);
            G.inputLocked = false;
            G.helpTankContext = null;
            if (doHelp) {
                Main.engine.resolveHelpTank(helperIdx);
            }
            render2(); refreshHandStyles2(); finishTurn2();
        };

        // 监听游戏结束
        const origCheckGameOver = Main.turnManager.checkGameOver.bind(Main.turnManager);
        const checkInterval = setInterval(async () => {
            if (!Main.turnManager || !Main.turnManager.gameOver) return;
            clearInterval(checkInterval);
            window.showHelpTankDialog = origShow; // 还原弹窗

            const winner = Main.turnManager.winnerCamp;
            if (winner === 'hero') {
                AI.train.stats.minimax.win++;
                AI.train.stats.deepseek.lose++;
            } else if (winner === 'rebel') {
                AI.train.stats.deepseek.win++;
                AI.train.stats.minimax.lose++;
            }

            // 复盘 + 权重更新
            await AI.train.reflect(winner, charIds);
            resolve();
        }, 500);

        // 启动 AI 行动
        setTimeout(() => AI.checkAndAct(), 300);
    });
};

AI.train.reflect = async function(winnerCamp, charIds) {
    const aiWon    = winnerCamp;
    const summary  = AI.log.slice(-20).map(l=>`T${l.turn} ${l.actor}(${l.score?.toFixed(0)||'?'}): ${l.reason}`).join('\n');
    const names    = charIds.map(id => CHAR_ID_MAP[id] || id);
    const charInfo = `本局阵容 HERO:${names[0]},${names[2]} vs REBEL:${names[1]},${names[3]}`;

    // 自动保存完整日志到 log/ 目录
    try {
        const logPanel   = document.getElementById('logPanel2');
        const logContent = logPanel ? logPanel.innerText : '';
        const dateStr    = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
        const filename   = `train_${AI.train.battleCount}_${names.join('_')}_${winnerCamp}win_${dateStr}.txt`;
        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content: `${charInfo}\n胜方:${winnerCamp}\n\n${logContent}\n\n--- AI行动摘要 ---\n${summary}` }),
        });
    } catch(e) { console.warn('[Train] 日志保存失败', e); }

    try {
        // 1. 让 DeepSeek 复盘，产出权重调整建议 + 新经验
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'deepseek',
                messages: [{
                    role: 'system',
                    content: `你是指尖博弈AI训练师。分析对战日志，输出严格JSON：
{
  "weight_deltas": { "star_2": -5, "zero_combo_atk": 3, ... },
  "new_rules": ["规则1（15字内）", "规则2"]
}
weight_deltas 只填需要调整的权重key，范围[-10,+10]。
new_rules 最多2条，不与已有规则重复。只输出JSON，无其他文字。`
                },{
                    role: 'user',
                    content: `${charInfo}\n胜方:${winnerCamp}\n${summary}\n\n已有经验:\n${(AI.knowledgeCache||'').slice(0,400)}\n\n当前权重(部分):\nstar_2=${AI.weights.star_2} star_3=${AI.weights.star_3} zero_combo_atk=${AI.weights.zero_combo_atk} wukong_02=${AI.weights.wukong_02}`
                }],
                temperature: 0.4,
                max_tokens: 400,
            }),
        });
        const data    = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const m       = content.match(/\{[\s\S]*\}/);
        if (m) {
            const parsed = JSON.parse(m[0]);

            // 应用权重增量（带边界，防止失控）
            if (parsed.weight_deltas) {
                for (const [key, delta] of Object.entries(parsed.weight_deltas)) {
                    if (AI.weights[key] !== undefined) {
                        const cur = AI.weights[key];
                        const next = cur + Number(delta);
                        // 保持符号，防止正权重变负
                        if (Math.sign(next) === Math.sign(cur) || cur === 0) {
                            AI.weights[key] = Math.round(next * 10) / 10;
                        }
                    }
                }
                console.log('[Train] 权重更新:', parsed.weight_deltas);
            }

            // 追加新经验到 knowledge.md
            if (parsed.new_rules && parsed.new_rules.length > 0) {
                const toAppend = '\n- ' + parsed.new_rules.join('\n- ');
                await fetch('/api/knowledge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ append: `\n## 训练复盘 第${AI.train.battleCount}局\n${toAppend}` }),
                });
                AI.knowledgeCache = null; // 下局重新加载
            }
        }
    } catch(e) { console.warn('[Train] 复盘失败', e); }
};

// 供外部 UI 读取的状态文本
AI.train.getStatusText = function() {
    const s     = AI.train.stats;
    const b     = AI.train.battleCount;
    const last  = AI.train._lastChars || [];
    const names = last.map(id => CHAR_ID_MAP[id] || id);
    const charStr = names.length === 4 ? `${names[0]},${names[2]} vs ${names[1]},${names[3]}` : '';
    return {
        status:  `第 ${b} 局${charStr ? ' | ' + charStr : ''}`,
        minimax: `W${s.minimax.win} L${s.minimax.lose}`,
        deepseek:`W${s.deepseek.win} L${s.deepseek.lose}`,
        weights: `star_2:${AI.weights.star_2} star_3:${AI.weights.star_3} zero_atk:${AI.weights.zero_combo_atk} wukong:${AI.weights.wukong_02}`,
    };
};
// ──────────────────────────────────────────────────
AI.reflectBattle = async function(winnerCamp) {
    if (!AI.enabled || AI.log.length < 3) return;
    const summary = AI.log.slice(-15).map(l=>`T${l.turn} ${l.actor}: ${l.reason}`).join('\n');
    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'deepseek',
                messages: [{
                    role: 'system',
                    content: '你是指尖博弈复盘师。提炼1-2条新经验，每条一行，具体可操作，不重复已有规则，只输出规则文本。'
                },{
                    role: 'user',
                    content: `AI${winnerCamp===AI.aiCamp?'胜':'败'}\n${summary}\n已有规则:\n${(AI.knowledgeCache||'').slice(0,400)}\n新经验:`
                }],
                temperature: 0.5, max_tokens: 200,
            }),
        });
        const data  = await r.json();
        const rules = data?.choices?.[0]?.message?.content?.trim();
        if (rules && rules.length > 10) {
            await fetch('/api/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ append: `\n## 复盘 ${new Date().toLocaleDateString()}\n${rules}` }),
            });
            AI.knowledgeCache = null;
        }
    } catch(e) { console.warn('[AI] reflect failed:', e); }
};
