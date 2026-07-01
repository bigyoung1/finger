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
//  角色权重系统（从各角色 skill md 的 ## 权重 块解析）
//  无全局默认权重，每个角色独立
// ──────────────────────────────────────────────────
// ──────────────────────────────────────────────────
//  全局模型配置（可在 UI 中实时切换）
//  providers: 'minimax' | 'deepseek' | 'qianfan'
// ──────────────────────────────────────────────────
var AI_MODEL_CONFIG = {
    p0: 'minimax',   // HERO 角色0
    p1: 'deepseek',  // REBEL 角色1
    p2: 'minimax',   // HERO 角色2
    p3: 'deepseek',  // REBEL 角色3
    train_main:   'minimax',   // 自战训练主力
    train_reflect: 'deepseek', // 自战复盘
    reflect:       'deepseek', // 玩家对战复盘
};

// 所有可选 provider
var AI_PROVIDERS = {
    minimax:  { label: '🔵 MiniMax',  color: '#1890ff' },
    deepseek: { label: '🟢 DeepSeek', color: '#52c41a' },
    qianfan:  { label: '🟠 千帆(讯飞)', color: '#fa8c16' },
};

// 工具函数：给某个角色 idx 分配 provider（按 AI_MODEL_CONFIG）
function getProviderForSlot(idx) {
    return AI_MODEL_CONFIG['p' + idx] || 'minimax';
}

var AI_BASE_WEIGHTS = {
    // ── 双子星权重（按用户优先级：9>0>5>7>6>8>4>2/3）──
    star_9: 500,  star_0: 480,
    star_5: 420,  star_7: 380,
    star_6: 300,  star_8: 270,
    star_4: 220,
    star_1: 110,
    star_2: 15,   star_3: 15,   // 最低价值双子星，AI主动回避但留个正值

    // ── 0组合 ──
    zero_combo_atk:    340,  // [0,1/5/8/9] 物伤组合，地位接近双子星
    zero_combo_heal:   240,
    zero_combo_7:      180,
    zero_combo_shield: 100,

    // ── 凑0本身（这是用户特别强调的：AI不喜欢拿0是问题）──
    build_zero: 340,

    // ── 单手6回血 ──
    six_heal: 130,

    // ── 击杀/路径 ──
    kill_bonus: 180,
    path_bonus: 50,

    // ── 帮敌方凑组合的惩罚（大幅加重，AI之前太轻易放给敌方双子星）──
    give_star_9:     -700,
    give_star_0:     -650,
    give_star_7:     -450,
    give_star_5:     -480,  // 新增：反弹盾给敌方很恶心
    give_star_6:     -350,  // 新增：90血给敌方
    give_star_8:     -300,  // 新增：再动+盾给敌方
    give_star_4:     -250,  // 新增：增伤翻倍给敌方
    give_star_other: -280,  // 其余双子星兜底（含2/3，凑给敌方收益低惩罚也低）
    give_zero_combo: -380,  // 帮敌方完成 [0,x]
    give_build_zero: -180,  // 新增：帮敌方凑出 0（让敌方下回合有0用）

    // ── 角色专属 ──
    mage_zero_atk: 90,   wukong_02: 380,
    ninja_7: 180,        zhangfei_diff: 2.0,
    daqiao_evolve: 50,
};
var AI_CHAR_WEIGHTS = {}; // { 角色名: { ...完整权重 } }，从 skill md 解析

// 从 skill md 文本里提取 ## 权重 代码块
function parseWeightsFromSkill(skillText) {
    const m = skillText.match(/##\s*权重\s*```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1].trim()); } catch { return null; }
}

// 获取角色权重（合并基础值 + 角色专属值）
// camp 参数可选：AI.evolve 测试时用于临时覆盖单个 key（不影响正式对局/训练）
function getCharWeights(charName, camp) {
    const base = AI_CHAR_WEIGHTS[charName] || AI_BASE_WEIGHTS;
    if (camp && window.AI && AI.evolve && AI.evolve._campOverride && AI.evolve._campOverride[camp]) {
        const ov = AI.evolve._campOverride[camp];
        // 浅拷贝一份，避免直接改写 AI_CHAR_WEIGHTS 污染其他阵营/正式对局
        return Object.assign({}, base, { [ov.weightKey]: ov.value });
    }
    return base;
}

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
    weights:       Object.assign({}, AI_BASE_WEIGHTS),
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
    AI.providerMap[seats[0]] = getProviderForSlot(seats[0]);
    AI.providerMap[seats[1]] = getProviderForSlot(seats[1]);
    AI.preloadAllSkills();
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
            AI.providerMap[p] = getProviderForSlot(parseInt(p));
        });
        AI.preloadAllSkills();
        if (!AI.knowledgeCache) AI.loadKnowledge();
    }
};

AI.stop = function() { AI.enabled = false; AI.thinkingPromise = null; };

// ──────────────────────────────────────────────────
//  权重与知识库 I/O
// ──────────────────────────────────────────────────
// 预加载所有角色 skill（权重同步解析）
AI.preloadAllSkills = async function() {
    const names = Object.values(CHAR_ID_MAP);
    await Promise.all(names.map(n => AI.loadSkill(n)));
    console.log('[AI] 所有角色 skill 和权重已加载', Object.keys(AI_CHAR_WEIGHTS));
};

// 把更新后的权重写回对应角色的 skill md（更新 ## 权重 代码块）
AI.saveCharWeights = async function(charName) {
    const w = AI_CHAR_WEIGHTS[charName];
    if (!w) return;
    try {
        await fetch('/api/skill-weight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: charName, weights: w }),
        });
    } catch(e) { console.warn('[AI] 权重写回失败', charName, e); }
};

AI.saveAllCharWeights = async function() {
    const names = Object.keys(AI_CHAR_WEIGHTS);
    await Promise.all(names.map(n => AI.saveCharWeights(n)));
    console.log('[AI] 所有角色权重已写回 skill md');
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
        const r    = await fetch('/api/skill?name=' + encodeURIComponent(name));
        const text = await r.text();
        AI.skillCache[name] = text;
        // 同时解析权重块，合并到角色专属权重
        const parsed = parseWeightsFromSkill(text);
        if (parsed) {
            AI_CHAR_WEIGHTS[name] = Object.assign({}, AI_BASE_WEIGHTS, parsed);
        }
        return text;
    } catch(e) { return ''; }
};

// ──────────────────────────────────────────────────
//  checkAndAct — render2 后调用
// ──────────────────────────────────────────────────
AI.checkAndAct = function() {
    if (!AI.enabled || AI.thinkingPromise) return;
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    const curIdx = Main.turnManager.currentPlayerIdx;
    const curActor = Main.turnManager.players && Main.turnManager.players[curIdx];

    // 兜底：如果联机/AI 局因为濒死帮抗或旧状态导致轮到已阵亡角色，房主负责推进到下一个可行动角色。
    if (curActor && curActor.hp <= 0 && !G.inputLocked && !G.helpTankContext && !G.wukongPending) {
        if (!window.ONLINE || !ONLINE.active || ONLINE.isHost()) {
            setTimeout(function(){ if (Main.turnManager && !Main.turnManager.gameOver) finishTurn2(); }, 0);
        }
        return;
    }

    if (G.inputLocked || G.helpTankContext || G.wukongPending) return;

    // 联机时，AI 角色只由房主驱动并广播操作；其他客户端只重放房主消息，避免多端同时思考/同时执行导致状态分叉。
    let isAI;
    if (window.ONLINE && ONLINE.active) {
        isAI = ONLINE.charControl[curIdx] === 'AI';
        if (!isAI || !ONLINE.isHost()) return;
    } else {
        isAI = Object.keys(AI.controlled).length > 0
            ? !!AI.controlled[curIdx]
            : campOf(curIdx) === AI.aiCamp;
        if (!isAI) return;
    }

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

    // 6. LLM 决策（15% 概率探索）—— headlessMode 时完全跳过LLM，纯启发式（用于批量统计调参）
    let chosen = top4[0];
    let reason = '启发式';

    if (AI.headlessMode) {
        reason = '启发式(headless)';
    } else if (Math.random() < 0.15 && top4.length > 1) {
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
// ── 阵营级上下文工具函数 ──
function campStats(actorIdx) {
    const players = Main.turnManager.players;
    const camp    = campOf(actorIdx);
    const mySeats = camp === 'hero' ? [0,2] : [1,3];
    const enSeats = camp === 'hero' ? [1,3] : [0,2];
    const myHp = mySeats.reduce((s,i) => s + Math.max(0, players[i]?.hp || 0), 0);
    const enHp = enSeats.reduce((s,i) => s + Math.max(0, players[i]?.hp || 0), 0);
    const myPoisoned = mySeats.some(i => {
        const p = players[i]; if (!p) return false;
        return (p.buffList||[]).some(b => (b.id==='POISON'||b.name==='毒') && b.layers > 0);
    });
    const enemyHas0 = enSeats.some(i => {
        const p = players[i]; if (!p || p.hp <= 0) return false;
        return p.hands[0] === 0 || p.hands[1] === 0;
    });
    return { myHp, enHp, ratio: enHp > 0 ? myHp / enHp : 99, myPoisoned, enemyHas0 };
}

AI.score = {};

AI.score.evaluate = function(actorIdx, action) {
    return AI.score.heuristic(actorIdx, action) + AI.score.lookahead(actorIdx, action);
};

AI.score.heuristic = function(actorIdx, action) {
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const target   = players[action.targetIdx];
    if (!target) return 0;

    const W        = getCharWeights(actor.name, campOf(actorIdx)); // 使用角色专属权重（支持evolve测试时按阵营覆盖）
    const myVal    = actor.hands[action.myHand];
    const tVal     = target.hands[action.touchHandIdx];
    const newVal   = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    const ctx      = campStats(actorIdx);
    const role     = charRole(actor.name);
    let score      = 0;

    // ── 自身debuff检测：雷霆之怒 + 中毒 ──
    const isEven = v => v === 2 || v === 4 || v === 6 || v === 8;
    const hasThunderRage = (actor.buffList || []).some(b => b.id && b.id.indexOf('THUNDER_RAGE_') === 0 && b.layers > 0);
    const isSelfPoisoned = (actor.buffList || []).some(b => b.id === 'POISON' && b.layers > 0);

    if (hasThunderRage) {
        // 身上有雷霆之怒：回合结束时按双手偶数个数触发伤害，能少一个偶数就少吃一次雷霆
        const evenBefore = (isEven(myVal) ? 1 : 0) + (isEven(otherVal) ? 1 : 0);
        const evenAfter  = (isEven(newVal) ? 1 : 0) + (isEven(otherVal) ? 1 : 0); // otherVal不变，newVal是动后的myVal手
        if (evenAfter < evenBefore) score += 60;  // 把偶数变成奇数，少一次雷霆
        else if (evenAfter > evenBefore) score -= 60; // 反而多了个偶数，更危险
    }

    if (isSelfPoisoned) {
        // 自己中毒：解毒类动作（RECOVERY回血）优先级显著提升
        // 注意：是否"得不偿失"（比如解毒但放给对方[7,7]）已经由下方lookahead的
        // give_star_7/give_zero_combo惩罚机制兜底，这里只管"我自己想解毒"这一半
        if (newVal === 6 && otherVal !== 6) score += 70; // 单手6解毒
        if (otherVal === 0 && [4,6].includes(newVal)) score += 70; // [0,4]/[0,6]解毒
        if (newVal === otherVal && newVal === 6) score += 50; // [6,6]解毒+回血
    }

    // ── 双子星（用权重表，低价值双子星为负）──
    if (newVal === otherVal && newVal > 0) {
        score += W['star_' + newVal] !== undefined ? W['star_' + newVal] : 15;

        // [8,8] 特别加成：双八触发2次额外行动，凑成[8,8]后双手都是8，
        // 之后两次额外行动可以反复碰场上"同一个敌方手"（敌方手不会因被碰而改变），
        // 把8变成 (8+敌方手值v)%10，两次都碰同一个v就能直达更高价值双子星。
        // 例如敌方场上有手值=1 → 两次碰它，8→9两次 → 凑成[9,9]（真伤/爆发拉满）
        // 反推表：v=1→[9,9] v=2→[0,0] v=9→[7,7] v=7→[5,5] v=6→[4,4]
        if (newVal === 8) {
            // 反推公式：敌方手值v，碰一次后 8+v 的结果 = (8+v)%10
            // 两次碰同一个v（敌方手不会因被碰而改变，可重复利用）→ 双手都变成这个值，凑成双子星T
            // T = (8+v)%10，遍历v=1..9（v=0不能碰）覆盖所有可能目标。
            // 注：[0,0](v=2)是合法的150真伤双子星（"双零即死"是旧规则，已被移除），照常计入。
            const enemySeatsForChain = [0,1,2,3].filter(i => i !== actorIdx && campOf(i) !== campOf(actorIdx));
            var bestChainBonus = 0;
            for (const eIdx of enemySeatsForChain) {
                const ep = players[eIdx];
                if (!ep || ep.hp <= 0) continue;
                for (const v of ep.hands) {
                    if (v === 0) continue; // 不能碰0手
                    const targetStar = (8 + v) % 10;
                    const targetKey = 'star_' + targetStar;
                    const targetVal = W[targetKey] !== undefined ? W[targetKey] : 15;
                    // 折扣：用掉了2次行动机会才换来这个值，且要等2回合后才真正打出，打个7折
                    const chainBonus = Math.floor(targetVal * 0.7);
                    if (chainBonus > bestChainBonus) bestChainBonus = chainBonus;
                }
            }
            if (bestChainBonus > 0) {
                score += bestChainBonus;
            }
        }
    }

    // ── 凑 0 ──
    if (newVal === 0 && otherVal > 0) score += W.build_zero;
    if (newVal === 0 && otherVal === 0) score -= 999; // 双零

    // ── 完成 [0,x] 组合 ──
    if (otherVal === 0 && newVal > 0) {
        if ([1,5,8,9].includes(newVal)) score += W.zero_combo_atk;
        else if ([4,6].includes(newVal)) {
            const healBonus = ctx.ratio < 0.7 ? W.zero_combo_heal * 1.3 : W.zero_combo_heal;
            score += healBonus;
        }
        else if (newVal === 7) score += W.zero_combo_7;
        else if ([2,3].includes(newVal)) score += W.zero_combo_shield;
        // 输出职业加算（法师/鸦眼/孙悟空等）
        if (role === 'output' && [1,5,8,9].includes(newVal)) score += W.mage_zero_atk;
    }

    // ── 0 倒计时压力（快到了就用，不惩罚持有 0）──
    if (myVal === 0) {
        const myZT = action.myHand === 0 ? actor.zeroTurns0 : actor.zeroTurns1;
        if (myZT <= 1) score += 30; // 倒计时快到了必须动这手
    }

    // ── [x,6] 单手 6 回血 ──
    if (newVal === 6 && otherVal !== 6) {
        const healBonus = ctx.ratio < 0.5 ? W.six_heal * 2.0 : (ctx.ratio < 0.8 ? W.six_heal * 1.2 : W.six_heal * 0.5);
        score += healBonus;
        if (role === 'output') score -= 30; // 输出职业回血收益低
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
            if (actor.hp > 340  && [1,5,8,9].includes(newVal))
                score += W.daqiao_evolve;
            break;
        case '鸦眼':
            const hasCrow = (target.buffList||[]).some(b=>b.id==='CROW'&&b.layers>0);
            if (hasCrow) score += 50;
            break;
    }

    // ── 上下文加分：基于阵营血量比、状态动态调节 ──
    // 激进：我方血量和远超敌方（>2倍）
    if (ctx.ratio > 2.0) {
        score += 25;
    }
    // 保守/防守：我方血量和远低于敌方（<0.5倍）
    else if (ctx.ratio < 0.5) {
        // 提升回复和防御相关权重
        if (newVal === 6) score += W.six_heal * 0.8;
        if (otherVal === 0 && [4,6].includes(newVal)) score += W.zero_combo_heal * 0.5;
        if (newVal === otherVal && newVal === 6) score += W['star_6'] * 0.3;
    }
    // 敌方有人持 0（下回合可能攻击）→ 增加造盾权重
    if (ctx.enemyHas0) {
        if (newVal === otherVal && [2,3].includes(newVal)) score += 45;
        if (otherVal === 0 && [2,3].includes(newVal)) score += W.zero_combo_shield * 0.6;
    }
    // 我方有人中毒 → 提升所有回血权重（含6/[6,6]和回血组合）
    if (ctx.myPoisoned) {
        if (newVal === 6) score += W.six_heal * 1.0;
        if (newVal === otherVal && newVal === 6) score += W['star_6'] * 0.5;
        if (otherVal === 0 && [4,6].includes(newVal)) score += W.zero_combo_heal * 0.6;
    }

    return score;
};

AI.score.lookahead = function(actorIdx, action) {
    const players  = Main.turnManager.players;
    const actor    = players[actorIdx];
    const target   = players[action.targetIdx];
    const W        = getCharWeights(actor.name, campOf(actorIdx));
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
    if (actor.name === '小乔') estDmg = Math.floor(estDmg * 1.5); // 小乔物伤×1.5
    if (charRole(actor.name) === 'output' && otherVal === 0 && [1,5,8,9].includes(newVal)) estDmg += 45; // 输出职业 0 组合追加法伤

    const shTotal = (dmgTarget.shieldList||[]).reduce((s,x) => s+(x.amount||0), 0);
    bonus += Math.max(0, estDmg - shTotal) * 0.5;

    // 击杀奖励
    if (estDmg > 0 && estDmg >= dmgTarget.hp) {
        bonus += W.kill_bonus;
        if ((dmgTarget.maxHp||999) < 200) bonus += 20; // 脆皮优先击杀
    }

    // ─── 我动完后，对方下回合行动时能凑出多危险的组合？ ───
    // 关键修复：之前这段写错了——把"对方的手被碰后的值"算成了 (对方手 + 我手) % 10，
    // 但实际游戏规则是"碰别人，变的是自己的手"，对方的手数值不会因我碰而变化。
    // 所以这里改为：模拟对方下回合用他的某只手 h_o 碰我的某只非0手 h_m，
    // 对方的 h_o 会变成 (h_o + h_m) % 10，看这是否凑出双子星 / 0组合 / 完成攻击型0组合。
    // 取所有对方可能行动里"对对方收益最大"的那一种，作为本次行动的"放给对方"惩罚。
    //
    // 注意：因为对方也可能选择碰我方"队友"而非碰我，但这里我们只评估"碰我"这一支线，
    // 简化模型避免计算量爆炸；这已经能解决"我留个5，对方能轻松凑[7,7]"这种漏算了。
    const enemySeats = [0,1,2,3].filter(i => i !== actorIdx && campOf(i) !== campOf(actorIdx));
    var worstPenalty = 0; // 取所有对方角色×对方手×我方动完后手 的最坏情况

    // 我动完后，我自己的双手：被动的那只=newVal，另一只=otherVal
    const myHandsAfter = [newVal, otherVal];

    for (const eIdx of enemySeats) {
        const ep = players[eIdx];
        if (!ep || ep.hp <= 0) continue;
        for (let eHand = 0; eHand < 2; eHand++) {
            const eVal = ep.hands[eHand];
            const eOtherVal = ep.hands[1 - eHand];
            if (eVal === 0 && eOtherVal === 0) continue;
            for (let myH = 0; myH < 2; myH++) {
                if (myHandsAfter[myH] === 0) continue;
                const eNewVal = (eVal + myHandsAfter[myH]) % 10;
                var penalty = 0;
                if (eNewVal === eOtherVal && eNewVal > 0) {
                    const key = 'give_star_' + eNewVal;
                    penalty = W[key] !== undefined ? W[key] : W.give_star_other;
                }
                if (eNewVal === 0 && eOtherVal > 0) {
                    penalty = Math.min(penalty, W.give_build_zero !== undefined ? W.give_build_zero : -180);
                }
                if (eOtherVal === 0 && eNewVal > 0) {
                    if ([1,5,8,9].includes(eNewVal)) {
                        penalty = Math.min(penalty, W.give_zero_combo);
                    } else {
                        penalty = Math.min(penalty, Math.floor(W.give_zero_combo * 0.5));
                    }
                }
                if (penalty < worstPenalty) worstPenalty = penalty;
            }
        }
    }
    // 关键：当我这一手本身收益巨大时（凑成0、双子星、击杀），lookahead 惩罚打折
    // 因为高收益动作意味着我下回合也有强力反制手段，"让出去"的风险其实没那么纯亏。
    // 否则AI会被lookahead惩罚吓得永远不敢凑0，宁可打无关痛痒的动作。
    var selfGainHasValue = (newVal === 0 && otherVal > 0)                  // 凑成 0
                        || (newVal === otherVal && newVal > 0 && [9,7,6,5,8].includes(newVal)) // 高价值双子星
                        || (estDmg > 0 && dmgTarget && estDmg >= dmgTarget.hp); // 击杀
    if (selfGainHasValue) worstPenalty = Math.floor(worstPenalty * 0.55);
    bonus += worstPenalty;

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
    const name    = actor.name;

    if (name === '鸦眼') {
        // 灼燃箭：只要血量够就开启
        if (!actor.useBurningArrow && actor.hp > 70)
            invokeAction2(actorIdx, 'toggleBurningArrow', {});
        // 魔王剑：乌鸦够6且灼燃开启且血量充足
        if (actor.useBurningArrow && actor.crowCount >= 6 && actor.hp > 180 && !actor.useDemonSword)
            invokeAction2(actorIdx, 'toggleDemonSword', {});
        // 乌鸦诅咒：敌方没有乌鸦buff时主动施加（走 invokeAction 而非弹窗，因为自战时弹窗无人点）
        const enemies = players.filter((p,i) => campOf(i) !== campOf(actorIdx) && p.hp > 0);
        const enemyHasCrow = enemies.some(p => (p.buffList||[]).some(b=>b.id==='CROW'&&b.layers>0));
        if (!enemyHasCrow && actor.hp > 50)
            invokeAction2(actorIdx, 'crowCurseTarget', { camp: 'enemy' });
    }

    if (name === '张飞') {
        const enemies   = players.filter((p,i) => campOf(i) !== campOf(actorIdx) && p.hp > 0);
        const modal     = actor.modal || 1;
        const campRatio = campStats(actorIdx).ratio; // 己方血量和 / 敌方血量和
        // 阵营血量比低（<0.8）→ 模态3（打人回血）
        if (campRatio < 0.8 && modal !== 3)
            invokeAction2(actorIdx, 'setModal', { modal: 3 });
        // 2v2 两个敌人都活着且血量健康 → 模态2（打两人）
        else if (enemies.length >= 2 && modal !== 2 && campRatio >= 0.8)
            invokeAction2(actorIdx, 'setModal', { modal: 2 });
        // 默认模态1
        else if (enemies.length < 2 && campRatio >= 0.8 && modal !== 1)
            invokeAction2(actorIdx, 'setModal', { modal: 1 });
    }

    if (name === '阴阳师') {
        const modal   = actor.modal || 'ren';
        const camp    = campOf(actorIdx);
        const seats   = camp === 'hero' ? [0,2] : [1,3];
        const eSeat   = camp === 'hero' ? [1,3] : [0,2];
        const myHP    = seats.reduce((s,i) => s + (players[i]?.hp||0), 0);
        const enHP    = eSeat.reduce((s,i) => s + (players[i]?.hp||0), 0);
        const winning = myHP > enHP * 0.8;

        const h = actor.hands;
        const hasAttackCombo = (h[0]===0&&[1,5,8,9].includes(h[1])) || (h[1]===0&&[1,5,8,9].includes(h[0]))
            || (h[0]===h[1] && h[0]>0 && [9,7,0].includes(h[0]));
        const hasHealCombo   = (h[0]===0&&[4,6].includes(h[1])) || (h[1]===0&&[4,6].includes(h[0]))
            || h[0]===6 || h[1]===6 || (h[0]===h[1]&&h[0]===6);
        const hasAnyGoodCombo = hasAttackCombo || hasHealCombo;

        // ── 攻略第7条：有好组合时直接用阴/阳，不切人 ──
        if (hasAttackCombo) {
            // 有攻击组合 → 阴最大化
            if (modal !== 'yin') invokeAction2(actorIdx, 'switchModal', { modal: 'yin' });
        } else if (hasHealCombo && !winning) {
            // 有回血组合且落后 → 阳最大化
            if (modal !== 'yang') invokeAction2(actorIdx, 'switchModal', { modal: 'yang' });
        } else if (hasHealCombo && winning) {
            // 有回血组合且占优 → 阴（回血变打伤，攻略第5点）
            if (modal !== 'yin') invokeAction2(actorIdx, 'switchModal', { modal: 'yin' });
        }
        // ── 无好组合时：执行刷盾循环（攻略第3/4点）──
        else {
            if (modal === 'ren') {
                // 人模态且无好组合 → 切阴/阳白嫖护盾
                // 占优切阴，落后切阳
                const target = winning ? 'yin' : 'yang';
                invokeAction2(actorIdx, 'switchModal', { modal: target });
            } else {
                // 已在阴/阳且无好组合 → 切回人（回护盾血量 + 获得免伤）
                invokeAction2(actorIdx, 'switchModal', { modal: 'ren' });
            }
        }
    }

    // 藏师：蛋糕使用决策
    if (name === '藏师') {
        const cakes = actor.cakes || 0;
        if (cakes >= 3) {
            // 找血量最低的敌人（蛋糕可豁免抗伤位，优先打血少的）
            const enemies = players
                .map((p, i) => ({ p, i }))
                .filter(({ p, i }) => campOf(i) !== campOf(actorIdx) && p.hp > 0)
                .sort((a, b) => a.p.hp - b.p.hp);
            if (enemies.length > 0) {
                const groups = Math.floor(cakes / 3);
                invokeAction2(actorIdx, 'useCake', {
                    targetIdx: enemies[0].i,
                    groupCount: groups,
                });
            }
        }
    }

    // 大乔进化
    // 旧判断用了不存在的 actor.evolved，导致大乔已进化/复活甲已用后，
    // 只要血量再次超过300，AI就会反复调用 evolve 并刷出“错误：不满足进化条件”。
    // 这里以 Haxe 暴露的 canEvolve() 为准；没有该方法时再走保守 fallback。
    if (name === '大乔') {
        const canEvolve = (typeof actor.canEvolve === 'function')
            ? actor.canEvolve()
            : (actor.hp > 300 && !actor.isGodForm && !actor.hasRevived);
        if (canEvolve) {
            invokeAction2(actorIdx, 'evolve', {}, false, { silent: true });
        }
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
    const players  = Main.turnManager.players;
    const helper   = players[helperIdx];
    const victim   = players[victimIdx];
    if (!helper || helper.hp <= 0) return false;
    if (!victim) return false;

    // 核心规则：只要扛得住就帮（victim 此时通常已经 hp<=0，不能因此直接拒绝）
    return totalPenalty < helper.hp;
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
    'yayan':     '鸦眼',   'zhaoyun':   '赵云',
};
const CHAR_NAME_MAP = Object.fromEntries(Object.entries(CHAR_ID_MAP).map(([k,v])=>[v,k]));

// 角色职业映射（用于 AI 决策替代硬编码名字检查）
const AI_CHAR_ROLE = {
    '法师': 'output', '鸦眼': 'output', '孙悟空': 'output',
    '藏师': 'tank',   '张飞': 'tank',
    // 其余为 semi_tank（半肉），无需显式列出
};
function charRole(name) { return AI_CHAR_ROLE[name] || 'semi_tank'; }

// 所有可训练角色 ID（排除杨大力）
const TRAINABLE_CHARS = Object.keys(CHAR_ID_MAP);

// 角色 HP 映射（用于选角配对检查）
const AI_CHAR_HP = {
    '小乔':360, '藏师':660, '法师':160, '孙悟空':260,
    '大乔':120, '忍者':300, '张飞':560, '阴阳师':240,
    '鸦眼':140, '赵云':200,
};

// 脆皮判定：HP < 200 视为脆皮
function isSquishy(name) { return (AI_CHAR_HP[name] || 350) < 200; }

// 坦克角色
const TANK_IDS = ['zangshi', 'zhangfei'];

// 按角色 ID 决定阵容类型
function decideFormation(charIds) {
    return charIds.some(id => TANK_IDS.includes(id)) ? 'tank_carry' : 'dual_half';
}

// 检查4人阵容是否合理：脆皮队友HP必须≥220
function isBalancedTeam(chars) {
    const names = chars.map(id => CHAR_ID_MAP[id] || id);
    // HERO: [0,2], REBEL: [1,3]
    for (const [a, b] of [[0,2],[1,3]]) {
        if (isSquishy(names[a]) && (AI_CHAR_HP[names[b]] || 350) < 220) return false;
        if (isSquishy(names[b]) && (AI_CHAR_HP[names[a]] || 350) < 220) return false;
    }
    return true;
}

// 随机选 4 个角色（上局用过的不选，脆皮队友必须≥220HP）
AI.train.pickChars = function(lastChars) {
    const pool = lastChars
        ? TRAINABLE_CHARS.filter(c => !lastChars.includes(c))
        : TRAINABLE_CHARS;
    const src  = pool.length >= 4 ? pool : TRAINABLE_CHARS;
    // 尝试多次抽取，找到合理阵容
    for (let attempt = 0; attempt < 30; attempt++) {
        const shuffled = src.slice().sort(() => Math.random() - 0.5);
        const pick = shuffled.slice(0, 4);
        if (isBalancedTeam(pick)) return pick;
    }
    // 30次都找不到 → 放宽限制，使用全部角色池重试
    const full = TRAINABLE_CHARS.slice().sort(() => Math.random() - 0.5);
    for (let attempt = 0; attempt < 30; attempt++) {
        const pick = full.slice().sort(() => Math.random() - 0.5).slice(0, 4);
        if (isBalancedTeam(pick)) return pick;
    }
    // 实在不行就返回第一次抽取结果
    return src.slice().sort(() => Math.random() - 0.5).slice(0, 4);
};

AI.train.start = async function() {
    if (AI.train.running) return;
    AI.train.running    = true;
    AI.train.battleCount = 0;
    await AI.preloadAllSkills();
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
        if (AI.train.battleCount % 5 === 0) await AI.saveAllCharWeights();
        await new Promise(r => setTimeout(r, 800)); // 局间间隔
    }
};

AI.train.stop = async function() {
    AI.train.running = false;
    await AI.saveAllCharWeights();
    console.log('[Train] 训练停止，所有角色权重已写回 skill md');
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
        AI.providerMap = { 0:getProviderForSlot(0), 1:getProviderForSlot(1), 2:getProviderForSlot(2), 3:getProviderForSlot(3) };
        AI.log        = [];

        document.getElementById('battleArena2').style.display  = 'block';
        document.getElementById('setupPanel2').style.display   = 'none';
        render2(); refreshHandStyles2(); updateTankButtons();

        // 注入帮抗自动决策：覆盖弹窗为 AI 自动判断
        const origShow = window.showHelpTankDialog;
        window.showHelpTankDialog = function(helperIdx, victimIdx, source, eventRecord) {
            // 事件模式（反弹/毒伤/模态②第二刀）用 eventRecord.amount，否则用主线 lastTouchDamageLog
            const pen = eventRecord
                ? Math.ceil(eventRecord.amount * 1.5)
                : (Main.engine.lastTouchDamageLog || []).reduce((s,l) => s + Math.ceil(l.outputAmount*1.5), 0);
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

            const winner = Main.turnManager.winningCamp;
            // winningCamp 是 Haxe enum 对象，需要用 _hx_name 或 toString 比较
            const winnerStr = winner ? (winner._hx_name || String(winner)).toUpperCase() : null;
            if (winnerStr === 'HERO') {
                AI.train.stats.minimax.win++;
                AI.train.stats.deepseek.lose++;
            } else if (winnerStr === 'REBEL') {
                AI.train.stats.deepseek.win++;
                AI.train.stats.minimax.lose++;
            }

            // 复盘 + 权重更新
            await AI.train.reflect(winnerStr, charIds);
            resolve();
        }, 500);

        // 启动 AI 行动
        setTimeout(() => AI.checkAndAct(), 300);
    });
};

AI.train.reflect = async function(winnerCamp, charIds) {
    const summary  = AI.log.slice(-30).map(l=>`T${l.turn} ${l.actor}(${l.score?.toFixed(0)||'?'}): ${l.reason}`).join('\n');
    const names    = charIds.map(id => CHAR_ID_MAP[id] || id);
    const charInfo = `本局阵容 HERO:${names[0]},${names[2]} vs REBEL:${names[1]},${names[3]}`;
    const dateStr  = new Date().toLocaleString('zh-CN');
    const resultStr = winnerCamp === 'HERO' ? `HERO胜(MiniMax ${names[0]},${names[2]})` :
                      winnerCamp === 'REBEL' ? `REBEL胜(DeepSeek ${names[1]},${names[3]})` : '平局';

    // ── 1. 保存完整日志到 log/ ──
    try {
        const logPanel   = document.getElementById('logPanel2');
        const logContent = logPanel ? logPanel.innerText : '';
        const filename   = `train_${AI.train.battleCount}_${winnerCamp||'draw'}_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,16)}.txt`;
        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content: `${dateStr}\n${charInfo}\n结果:${resultStr}\n\n${logContent}` }),
        });
    } catch(e) { console.warn('[Train] 日志保存失败', e); }

    // ── 2. DeepSeek 复盘：产出权重增量 + 新经验 + 各角色攻略更新 ──
    try {
        const logPanel   = document.getElementById('logPanel2');
        const battleLog  = logPanel ? logPanel.innerText.slice(-2000) : '';

        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: AI_MODEL_CONFIG.train_reflect,
                messages: [{
                    role: 'system',
                    content: `你是指尖博弈AI训练师。分析对战，输出严格JSON（无其他文字）：
{
  "battle_summary": "时间戳 结果 胜因/败因 关键时刻（100字内）",
  "weight_deltas": { "star_2": -5, "zero_combo_atk": 3 },
  "new_rules": ["规则（15字内）"],
  "char_updates": {
    "角色名": "新增或修改的攻略内容（50字内，null表示无需修改）"
  }
}
weight_deltas 范围[-10,+10]，只填需要调整的key。
new_rules 最多2条。char_updates 只填本局参战角色，内容具体可操作。`
                },{
                    role: 'user',
                    content: `【${dateStr}】${charInfo} 结果:${resultStr}\n\n战斗日志(节选):\n${battleLog.slice(0,1500)}\n\nAI行动:\n${summary.slice(0,500)}\n\n角色权重(节选):\n${names.map(n=>`${n}: star_2=${(AI_CHAR_WEIGHTS[n]||AI_BASE_WEIGHTS).star_2} zero_atk=${(AI_CHAR_WEIGHTS[n]||AI_BASE_WEIGHTS).zero_combo_atk}`).join(', ')}\n已有经验(节选):\n${(AI.knowledgeCache||'').slice(0,300)}`
                }],
                temperature: 0.4,
                max_tokens: 600,
            }),
        });
        const data    = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const m       = content.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('No JSON in response');
        const parsed = JSON.parse(m[0]);

        // 应用权重增量（胜方强化，败方弱化，直接更新 AI_CHAR_WEIGHTS）
        if (parsed.weight_deltas) {
            const applyDelta = (charName, deltas, sign) => {
                if (!AI_CHAR_WEIGHTS[charName])
                    AI_CHAR_WEIGHTS[charName] = Object.assign({}, AI_BASE_WEIGHTS);
                const w = AI_CHAR_WEIGHTS[charName];
                for (const [key, delta] of Object.entries(deltas)) {
                    if (w[key] !== undefined) {
                        const cur = w[key], next = cur + Number(delta) * sign;
                        if (Math.sign(next) === Math.sign(cur) || cur === 0)
                            w[key] = Math.round(next * 10) / 10;
                    }
                }
            };
            const heroChars  = [names[0], names[2]];
            const rebelChars = [names[1], names[3]];
            const winChars   = winnerCamp === 'HERO' ? heroChars : rebelChars;
            const loseChars  = winnerCamp === 'HERO' ? rebelChars : heroChars;
            winChars.forEach(n => n && applyDelta(n, parsed.weight_deltas, 1));
            loseChars.forEach(n => n && applyDelta(n, parsed.weight_deltas, -0.5));
            console.log('[Train] 权重更新:', parsed.weight_deltas);
        }

        // 追加知识库
        const summary_text = parsed.battle_summary || resultStr;
        const newRules = parsed.new_rules?.length > 0 ? '\n- ' + parsed.new_rules.join('\n- ') : '';
        await fetch('/api/knowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ append: `\n\n## 第${AI.train.battleCount}局复盘 ${dateStr}\n${summary_text}${newRules}` }),
        });
        AI.knowledgeCache = null;

        // 把复盘记录 + 新权重写回各角色 skill md
        if (parsed.char_updates) {
            for (const [charName, update] of Object.entries(parsed.char_updates)) {
                if (!update) continue;
                const isWinner = (winnerCamp==='HERO'&&[names[0],names[2]].includes(charName))
                    || (winnerCamp==='REBEL'&&[names[1],names[3]].includes(charName));
                const tag = isWinner ? '✅ 胜' : '❌ 败';
                // 1. 追加复盘记录
                const recap = `\n\n## 复盘 ${dateStr} ${tag}（vs ${charInfo}）\n${update}`;
                // 2. 更新权重块（重写 ## 权重 段）
                const newW = AI_CHAR_WEIGHTS[charName];
                await fetch('/api/skill-weight', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: charName, weights: newW || null, append: recap }),
                });
                // 清缓存让下局重新加载
                delete AI.skillCache[charName];
            }
        }
    } catch(e) { console.warn('[Train] 复盘失败', e); }
};

// 供外部 UI 读取的状态文本
AI.train.getStatusText = function() {
    const s      = AI.train.stats;
    const b      = AI.train.battleCount;
    const last   = AI.train._lastChars || [];
    const names  = last.map(id => CHAR_ID_MAP[id] || id);
    const charStr = names.length === 4 ? `${names[0]},${names[2]} vs ${names[1]},${names[3]}` : '';
    const mmTotal = s.minimax.win + s.minimax.lose;
    const dsTotal = s.deepseek.win + s.deepseek.lose;
    return {
        status:   `第 ${b} 局${charStr ? ' | ' + charStr : ''}`,
        minimax:  `W${s.minimax.win} L${s.minimax.lose}`,
        deepseek: `W${s.deepseek.win} L${s.deepseek.lose}`,
        rateMM:   mmTotal > 0 ? `胜率 ${Math.round(s.minimax.win/mmTotal*100)}%` : '胜率 -',
        rateDS:   dsTotal > 0 ? `胜率 ${Math.round(s.deepseek.win/dsTotal*100)}%` : '胜率 -',
        weights:  `已加载角色: ${Object.keys(AI_CHAR_WEIGHTS).join(', ') || '加载中...'}`,
    };
};

// ══════════════════════════════════════════════════
//  AI.evolve — 批量自对弈数值调参（不调用LLM，纯本地统计）
//
//  设计目的：
//    LLM内战(AI.train)负责"战略层"决策好不好（切模态/帮抗/开技能时机），
//    这部分涉及复杂局面理解，LLM比纯公式聪明，继续保留。
//    但权重表里的具体数字（star_9该是400还是450？X_CAP该是80还是120？）
//    这类连续数值问题，靠LLM"读日志猜"不如直接跑几百局看真实胜率准。
//
//  用法：
//    AI.evolve.testWeight('赵云', 'star_9', [300, 400, 500], 60)
//    → 对"赵云"角色的 star_9 权重，分别设成300/400/500，每个值跑60局镜像对局
//      （即两边都用赵云+同一个固定对手，只有 star_9 不同），统计胜率，
//      返回每个候选值对应的胜率，方便挑出统计上更优的数值。
//
//  关键设计：
//    - headlessMode=true，跳过所有 LLM 调用，纯启发式打分选择，速度极快
//    - 镜像对局：避免阵容随机性干扰，只让被测权重产生差异
//    - 不渲染DOM（每局跳过 render2，只在必要时调用驱动逻辑前进）
//    - 跑完后自动恢复 AI_CHAR_WEIGHTS 原值，不污染当前权重状态
// ══════════════════════════════════════════════════
AI.evolve = {
    running: false,
    log: [],
};

// 跑一局 headless 对战（无渲染、无LLM、无复盘写文件），返回胜方阵营字符串
AI.evolve.runHeadlessBattle = function(charIds) {
    return new Promise(resolve => {
        if (typeof setupTrace2v2 === 'function') setupTrace2v2();
        if (typeof clearTankResolver === 'function') clearTankResolver();
        if (typeof resetAvatars === 'function') resetAvatars();
        clearInterval(G.stealTimer || 0);
        G.stealQueue = [];
        window._stealUsedThisTurn = {};
        G.step = 0; G.myHandIdx = -1; G.myPlayerIdx = -1;

        Main.setupGame2v2(charIds[0], charIds[1], charIds[2], charIds[3]);

        const heroFormation  = decideFormation([charIds[0], charIds[2]]);
        const rebelFormation = decideFormation([charIds[1], charIds[3]]);
        G.formation = { hero: heroFormation, rebel: rebelFormation };
        G.tankIdx   = { hero: 0, rebel: 1 };
        G.tankIdx.hero  = TANK_IDS.includes(charIds[0]) ? 0 : (TANK_IDS.includes(charIds[2]) ? 2 : 0);
        G.tankIdx.rebel = TANK_IDS.includes(charIds[1]) ? 1 : (TANK_IDS.includes(charIds[3]) ? 3 : 1);
        if (typeof setupTankResolver === 'function') setupTankResolver();

        AI.enabled     = true;
        AI.controlled  = { 0:true, 1:true, 2:true, 3:true };
        AI.headlessMode = true; // 关键：跳过LLM调用，纯启发式
        AI.log         = [];

        // 帮抗：直接走 AI.helpTank.decide，不弹窗、不渲染
        const origShow = window.showHelpTankDialog;
        window.showHelpTankDialog = function(helperIdx, victimIdx, source, eventRecord) {
            const pen = eventRecord
                ? Math.ceil(eventRecord.amount * 1.5)
                : (Main.engine.lastTouchDamageLog || []).reduce((s,l) => s + Math.ceil(l.outputAmount*1.5), 0);
            const doHelp = AI.helpTank.decide(helperIdx, victimIdx, pen);
            G.inputLocked = false;
            G.helpTankContext = null;
            if (doHelp) Main.engine.resolveHelpTank(helperIdx);
            finishTurn2(); // 不渲染，直接继续
        };

        // 防止死循环：最多跑 500 个 AI 回合还没结束就强制判平局退出
        let safetyCounter = 0;
        const MAX_TURNS = 500;

        const driveLoop = () => {
            if (!AI.evolve.running && !AI.evolve._forceOneShot) {
                window.showHelpTankDialog = origShow;
                resolve(null); // 被外部中止
                return;
            }
            if (Main.turnManager && Main.turnManager.gameOver) {
                window.showHelpTankDialog = origShow;
                AI.headlessMode = false;
                const winner = Main.turnManager.winningCamp;
                const winnerStr = winner ? (winner._hx_name || String(winner)).toUpperCase() : null;
                resolve(winnerStr);
                return;
            }
            safetyCounter++;
            if (safetyCounter > MAX_TURNS) {
                window.showHelpTankDialog = origShow;
                AI.headlessMode = false;
                resolve('DRAW_TIMEOUT');
                return;
            }
            // 不渲染，直接驱动 AI 思考+行动，思考完后立即排下一轮（用 Promise 链避免堆栈溢出）
            if (!G.inputLocked && !G.helpTankContext && !G.wukongPending && AI.enabled && !AI.thinkingPromise) {
                const curIdx = Main.turnManager.currentPlayerIdx;
                AI.thinkingPromise = AI.takeTurn(curIdx).finally(() => { AI.thinkingPromise = null; });
            }
            // 用 setTimeout(0) 让出主线程，避免长时间阻塞页面/浏览器报"脚本无响应"
            setTimeout(driveLoop, 0);
        };
        driveLoop();
    });
};

// 临时替换某角色的某个权重 key（跑完后必须用 restoreCharWeight 还原）
AI.evolve._backup = {};
AI.evolve.setCharWeight = function(charName, key, value) {
    if (!AI_CHAR_WEIGHTS[charName]) AI_CHAR_WEIGHTS[charName] = Object.assign({}, AI_BASE_WEIGHTS);
    if (!(charName in AI.evolve._backup)) AI.evolve._backup[charName] = Object.assign({}, AI_CHAR_WEIGHTS[charName]);
    AI_CHAR_WEIGHTS[charName][key] = value;
};
AI.evolve.restoreCharWeights = function(charName) {
    if (AI.evolve._backup[charName]) {
        AI_CHAR_WEIGHTS[charName] = AI.evolve._backup[charName];
        delete AI.evolve._backup[charName];
    }
};

// 临时按"槛位"覆盖某个角色的某个权重——用于让HERO和REBEL两边用同名角色但不同权重对打。
// 实现方式：在 getCharWeights 查找前，先检查 AI.evolve._campOverride[camp] 是否命中。
AI.evolve._campOverride = { hero: null, rebel: null }; // { weightKey, value } 或 null

/**
 * 两两对抗式权重测试：让候选值轮流和"基准值"对打，用真实胜率说话。
 * 比"打沙包"更准确，因为权重的价值往往体现在"和势均力敌的对手互动时的边际收益"。
 *
 * @param charName  角色名（双方都用这个角色，保证除被测权重外完全对称）
 * @param weightKey 权重key
 * @param candidates 候选值数组（会依次和 baseline 对打）
 * @param gamesPerValue 每个候选值跑多少局
 * @param onProgress 进度回调
 * @returns { baseline, candidates: [{value, winsVsBaseline, lossesVsBaseline, winRate}], best }
 */
AI.evolve.testWeight = async function(charName, weightKey, candidates, gamesPerValue, opponentCharId, onProgress) {
    if (AI.evolve.running) { console.warn('[Evolve] 已有任务在跑，请先停止'); return null; }
    AI.evolve.running = true;
    AI.evolve.log = [];

    const myCharId = CHAR_NAME_MAP[charName];
    if (!myCharId) { AI.evolve.running = false; throw new Error(`未知角色名: ${charName}`); }
    const oppId = opponentCharId || myCharId; // 默认对手=自己（同角色对打，只有权重不同）

    const baselineValue = (AI_CHAR_WEIGHTS[charName] || AI_BASE_WEIGHTS)[weightKey];
    const results = [];

    for (let ci = 0; ci < candidates.length; ci++) {
        const val = candidates[ci];
        let wins = 0, losses = 0, draws = 0;

        for (let g = 0; g < gamesPerValue; g++) {
            if (!AI.evolve.running) break;

            // HERO方([0,2])用候选值，REBEL方([1,3])用基准值 —— 通过 campOverride 让同一个角色名在不同阵营吃不同权重
            AI.evolve._campOverride.hero  = { weightKey, value: val };
            AI.evolve._campOverride.rebel = { weightKey, value: baselineValue };

            const charIds = [myCharId, oppId, myCharId, oppId]; // HERO:[候选角色,陪练] REBEL:[基准角色,陪练]
            const winner = await AI.evolve.runHeadlessBattle(charIds);

            AI.evolve._campOverride.hero  = null;
            AI.evolve._campOverride.rebel = null;

            if (winner === 'HERO') wins++;
            else if (winner === 'REBEL') losses++;
            else draws++;

            if (onProgress) onProgress(ci, g, gamesPerValue);
        }

        const total = wins + losses + draws;
        const winRate = total > 0 ? wins / total : 0;
        results.push({ value: val, wins, losses, draws, winRate });
        AI.evolve.log.push(`[Evolve] ${charName}.${weightKey}: 候选${val} vs 基准${baselineValue} → ${wins}胜${losses}负${draws}平 (候选胜率${(winRate*100).toFixed(1)}%)`);
        console.log(AI.evolve.log[AI.evolve.log.length - 1]);
    }

    AI.evolve.running = false;
    AI.headlessMode = false;

    const best = results.slice().sort((a,b) => b.winRate - a.winRate)[0];
    return { baseline: baselineValue, candidates: results, best: best ? best.value : baselineValue };
};

AI.evolve.stop = function() {
    AI.evolve.running = false;
    AI.evolve.autoTuning = false;
};

// ══════════════════════════════════════════════════
//  AI.evolve.autoTune — 全自动批量调参
//  不需要手动选角色/权重/候选值：
//    1. 自动遍历所有角色 × 所有权重key
//    2. 每个key自动生成候选值（基准 ±20%、±40%）
//    3. 胜率显著优于基准（差值超过阈值）才采纳，避免噪音误改
//    4. 采纳的改动自动写回 skill md（调 AI.saveCharWeights）
//    5. 跑完输出完整报告
// ══════════════════════════════════════════════════
AI.evolve.autoTuning = false;
AI.evolve.autoTuneLog = [];

// 不参与自动调参的key（非数值型/物理意义特殊，乱调容易产生荒谬结果）
const EVOLVE_SKIP_KEYS = []; // 目前28个key都是数值型，暂不跳过任何key；如有特殊key可加进来

// 根据基准值生成候选值（±20%、±40%，四舍五入到合理精度）
function genCandidates(baseline) {
    if (baseline === 0) return [-5, 5, 10, -10]; // 0值特殊处理，给一个小范围探索
    const candidates = [
        baseline,
        Math.round(baseline * 1.2 * 10) / 10,
        Math.round(baseline * 0.8 * 10) / 10,
        Math.round(baseline * 1.4 * 10) / 10,
        Math.round(baseline * 0.6 * 10) / 10,
    ];
    // 去重（避免基准值和某候选值四舍五入后相同）
    return [...new Set(candidates)];
}

/**
 * 全自动批量调参主流程。
 * @param options.charNames     要测的角色列表（默认全部可训练角色）
 * @param options.gamesPerValue 每个候选值跑几局（默认20，越多越准但越慢）
 * @param options.adoptThreshold 候选胜率超过基准胜率多少才采纳（默认0.08，即8个百分点）
 * @param options.onProgress    进度回调 (text) => void
 */
AI.evolve.autoTune = async function(options) {
    if (AI.evolve.autoTuning) { console.warn('[AutoTune] 已在运行'); return null; }
    options = options || {};
    const charNames      = options.charNames || Object.values(CHAR_ID_MAP);
    const gamesPerValue  = options.gamesPerValue || 20;
    const adoptThreshold = options.adoptThreshold ?? 0.08;
    const onProgress     = options.onProgress || function(){};

    AI.evolve.autoTuning  = true;
    AI.evolve.autoTuneLog = [];
    const report = []; // { charName, key, baseline, adopted, newValue, winRate }

    // 确保所有角色权重已加载
    await AI.preloadAllSkills();

    outer:
    for (const charName of charNames) {
        const weights = AI_CHAR_WEIGHTS[charName] || Object.assign({}, AI_BASE_WEIGHTS);
        const keys = Object.keys(weights).filter(k => !EVOLVE_SKIP_KEYS.includes(k));

        for (const key of keys) {
            if (!AI.evolve.autoTuning) break outer; // 允许中途停止

            const baseline   = weights[key];
            const candidates = genCandidates(baseline).filter(v => v !== baseline);
            if (candidates.length === 0) continue;

            onProgress(`🧬 测试 ${charName}.${key}（基准=${baseline}，候选=[${candidates.join(',')}]）`);

            let result;
            try {
                result = await AI.evolve.testWeight(charName, key, candidates, gamesPerValue, null,
                    (ci, g) => onProgress(`${charName}.${key} 候选${candidates[ci]}：第${g+1}/${gamesPerValue}局`));
            } catch (e) {
                onProgress(`⚠️ ${charName}.${key} 测试出错：${e.message}`);
                continue;
            }
            if (!result) continue;

            const best = result.candidates.slice().sort((a,b) => b.winRate - a.winRate)[0];
            // 基准值本身没有显式胜率（它是对照基线，定义为0.5）；候选要明显超过0.5+阈值才采纳
            const baselineWinRate = 0.5;
            const adopted = best.winRate >= baselineWinRate + adoptThreshold;

            if (adopted) {
                AI_CHAR_WEIGHTS[charName][key] = best.value;
                await AI.saveCharWeights(charName); // 自动写回 skill md
                onProgress(`✅ 采纳：${charName}.${key} ${baseline} → ${best.value}（胜率${(best.winRate*100).toFixed(1)}%）`);
            } else {
                onProgress(`➖ 维持：${charName}.${key} 保持 ${baseline}（最佳候选胜率仅${(best.winRate*100).toFixed(1)}%，未达采纳线）`);
            }

            report.push({
                charName, key, baseline,
                adopted, newValue: adopted ? best.value : baseline,
                winRate: best.winRate,
                allCandidates: result.candidates,
            });
            AI.evolve.autoTuneLog.push(report[report.length - 1]);
        }
    }

    AI.evolve.autoTuning = false;
    onProgress(`🏁 自动调参完成，共测试 ${report.length} 个权重，采纳 ${report.filter(r=>r.adopted).length} 处改动`);
    return report;
};

// ──────────────────────────────────────────────────
AI.reflectBattle = async function(winnerCamp) {
    if (!AI.enabled || AI.log.length < 3) return;
    const summary  = AI.log.slice(-15).map(l=>`T${l.turn} ${l.actor}: ${l.reason}`).join('\n');
    const dateStr  = new Date().toLocaleString('zh-CN');
    const players  = Main.turnManager?.players || [];
    const charNames = players.map(p => p.name);
    const aiWon    = winnerCamp === (AI.aiCamp === 'rebel' ? 'REBEL' : 'HERO');

    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: AI_MODEL_CONFIG.reflect,
                messages: [{
                    role: 'system',
                    content: `你是指尖博弈复盘师。输出严格JSON：
{"new_rules":["规则1","规则2"],"weight_deltas":{"star_2":-3},"char_updates":{"角色名":"攻略更新（50字内）"}}
new_rules最多2条，weight_deltas范围[-8,+8]，char_updates只填参战角色。只输出JSON。`
                },{
                    role: 'user',
                    content: `AI${aiWon?'胜':'败'} 阵容:${charNames.join(',')}\n${summary}\n已有规则:\n${(AI.knowledgeCache||'').slice(0,400)}`
                }],
                temperature: 0.5, max_tokens: 300,
            }),
        });
        const data  = await r.json();
        const text  = data?.choices?.[0]?.message?.content?.trim() || '';
        const m     = text.match(/\{[\s\S]*\}/);
        if (!m) return;
        const parsed = JSON.parse(m[0]);

        // 追加知识库
        if (parsed.new_rules?.length > 0) {
            await fetch('/api/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ append: `\n\n## 复盘 ${dateStr}\n- ` + parsed.new_rules.join('\n- ') }),
            });
            AI.knowledgeCache = null;
        }

        // 更新权重并写回 skill 文件
        if (parsed.weight_deltas) {
            charNames.forEach((name, idx) => {
                if (!AI_CHAR_WEIGHTS[name]) AI_CHAR_WEIGHTS[name] = Object.assign({}, AI_BASE_WEIGHTS);
                const w    = AI_CHAR_WEIGHTS[name];
                const sign = (campOf(idx) === (AI.aiCamp || 'rebel') ? 1 : -0.5) * (aiWon ? 1 : -1);
                for (const [key, delta] of Object.entries(parsed.weight_deltas)) {
                    if (w[key] !== undefined) {
                        const cur = w[key], next = cur + Number(delta) * sign;
                        if (Math.sign(next) === Math.sign(cur) || cur === 0)
                            w[key] = Math.round(next * 10) / 10;
                    }
                }
            });
        }

        // 写回 skill 文件（权重 + 复盘记录）
        if (parsed.char_updates) {
            for (const [charName, update] of Object.entries(parsed.char_updates)) {
                if (!update) continue;
                const tag   = charNames.includes(charName) ? (aiWon ? '✅ 胜' : '❌ 败') : '';
                const recap = `\n\n## 复盘 ${dateStr} ${tag}\n${update}`;
                await fetch('/api/skill-weight', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: charName, weights: AI_CHAR_WEIGHTS[charName] || null, append: recap }),
                });
                delete AI.skillCache[charName];
            }
        }
    } catch(e) { console.warn('[AI] reflect failed:', e); }
};
