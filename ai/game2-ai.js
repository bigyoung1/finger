// ════════════════════════════════════════════════════════
//  game2-ai.js  vs AI 模式 — LLM + 启发式双层决策
// ════════════════════════════════════════════════════════
//  设计：
//   1. 玩家轮到 AI 控制的角色行动时，触发 AIController.takeTurn
//   2. 先用启发式 AIThink 列出所有合法动作的初步评分
//   3. 取 top-3 候选送给 MiniMax LLM，附带知识库 + 局面快照
//   4. LLM 返回选择 + 简短理由
//   5. 失败时回退到启发式 top-1
//   6. 战斗结束后调用 reflectBattle() 让 LLM 复盘 → 追加经验
// ════════════════════════════════════════════════════════

window.AI = {
    enabled: false,              // 是否启用 AI 对战模式
    aiCamp: 'rebel',             // AI 控制的阵营
    knowledgeCache: null,        // 知识库缓存
    thinkingPromise: null,       // 当前思考中的 promise（防止并发）
    log: [],                     // 本局战斗日志（供复盘用）
};

// ── 启动 vs AI 模式 ──
AI.start = function(aiCamp) {
    AI.enabled = true;
    AI.aiCamp = aiCamp || 'rebel';
    AI.log = [];
    AI.loadKnowledge();
    console.log('[AI] vs AI 模式启用，AI 控制阵营：', AI.aiCamp);
};

AI.stop = function() {
    AI.enabled = false;
    AI.thinkingPromise = null;
};

// ── 加载经验库 ──
AI.loadKnowledge = async function() {
    try {
        const r = await fetch('/api/knowledge');
        AI.knowledgeCache = await r.text();
    } catch (e) {
        AI.knowledgeCache = '';
    }
};

// ── render2 后调用：检查是否轮到 AI ──
AI.checkAndAct = function() {
    if (!AI.enabled || AI.thinkingPromise) return;
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    if (G.inputLocked || G.helpTankContext || G.wukongPending) return;

    const curIdx = Main.turnManager.currentPlayerIdx;
    const curCamp = campOf(curIdx);
    if (curCamp !== AI.aiCamp) return;

    // 锁住输入，开始思考
    AI.thinkingPromise = AI.takeTurn(curIdx).finally(() => {
        AI.thinkingPromise = null;
    });
};

// ── AI 行动主流程 ──
AI.takeTurn = async function(actorIdx) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];

    setHint2('🤖 AI 思考中...');

    // 1. 列出所有合法 (myHand, touchTargetIdx, touchHandIdx) 三元组
    const candidates = AI.enumerateLegalActions(actorIdx);
    if (candidates.length === 0) {
        // 没有合法动作（双0），直接结束回合
        finishTurn2();
        return;
    }

    // 2. 启发式打分 + 取 top-3
    candidates.forEach(c => {
        const h = AI.scoreActionHeuristic(actorIdx, c);
        const l = AI.lookaheadScore(actorIdx, c);
        c.heuristicScore = h + l;
        c._h = h; c._l = l; // 调试用
    });
    candidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
    const top3 = candidates.slice(0, 3);

    // 3. 调 LLM 决策（带3-5秒超时）
    let chosen = top3[0]; // 默认启发式最优
    let reason = '启发式选择';
    try {
        const llmResult = await AI.askLLM(actorIdx, top3);
        if (llmResult && typeof llmResult.choice === 'number') {
            const idx = Math.max(0, Math.min(top3.length - 1, llmResult.choice));
            chosen = top3[idx];
            reason = llmResult.reason || 'LLM选择';
        }
    } catch (e) {
        console.warn('[AI] LLM 调用失败，回退启发式:', e);
    }

    // 4. 记录到本局日志
    AI.log.push({
        turn: Main.turnManager.turnCount,
        actor: actor.name,
        actorHands: actor.hands.slice(),
        action: chosen,
        reason: reason,
    });

    // 5. 执行（包括可能的鸦眼/张飞主动技能：先看 actor.getCustomActions 看有没有要开的）
    AI.maybeUseCustomAction(actorIdx);

    // 6. 触发攻击（doAttack2 走完整流程）
    const targetIdx = chosen.targetIdx;
    const dmgTargetIdx = getActualTarget(targetIdx);
    setHint2('🤖 AI: ' + reason);
    doAttack2(actorIdx, chosen.myHand, targetIdx, chosen.touchHandIdx, dmgTargetIdx);
};

// ── 枚举所有合法动作 ──
AI.enumerateLegalActions = function(actorIdx) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const result = [];

    for (let myHand = 0; myHand < 2; myHand++) {
        if (actor.hands[myHand] === 0 && actor.zeroTurns0 !== undefined) {
            // 持有0但倒计时充裕时也可以不动0
            // 直接尝试，让 isValidTouch 决定
        }
        for (let tIdx = 0; tIdx < players.length; tIdx++) {
            if (campOf(tIdx) === campOf(actorIdx)) continue; // 不能碰队友
            const tp = players[tIdx];
            if (!tp || tp.hp <= 0) continue;
            for (let tHand = 0; tHand < 2; tHand++) {
                if (tp.hands[tHand] === 0) continue; // 不能碰0
                const valid = !actor.isValidTouch || actor.isValidTouch(myHand, tp, tHand);
                if (!valid) continue;
                result.push({ myHand: myHand, targetIdx: tIdx, touchHandIdx: tHand });
            }
        }
    }
    return result;
};

// ── 启发式打分（简化版，实际可以调 Haxe 的 AIThink）──
AI.scoreActionHeuristic = function(actorIdx, action) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const target = players[action.targetIdx];
    let score = 0;

    const myVal = actor.hands[action.myHand];
    const tVal = target.hands[action.touchHandIdx];
    const newVal = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    const hpRatio = actor.hp / actor.maxHp;
    const tHpRatio = target.hp / target.maxHp;

    // ── 双子星（按实际价值差异化）──
    if (newVal === otherVal && newVal > 0) {
        const doubleScore = {0:120, 9:100, 7:70, 6:60, 4:40, 5:35, 8:30, 1:40, 2:15, 3:15};
        score += doubleScore[newVal] || 20;
    }

    // ── 0 组合 ──
    if (newVal === 0 && otherVal > 0) {
        score += 25; // 凑出 0
        // 但如果倒计时即将到 1，惩罚（怕另一只手还没动）
        const otherZeroTurns = action.myHand === 0 ? actor.zeroTurns1 : actor.zeroTurns0;
        if (otherVal === 0 && otherZeroTurns <= 1) score -= 30;
    }
    if (otherVal === 0 && newVal > 0) {
        // 完成 [0,x] 组合
        if (newVal === 1 || newVal === 5 || newVal === 8 || newVal === 9) score += 50; // 攻击型
        if (newVal === 6) score += 35;  // 回血
        if (newVal === 4) score += 30;  // 回血
        if (newVal === 2 || newVal === 3) score += 20; // 护盾
        if (newVal === 7) score += 25;  // 小毒
    }

    // ── 双零自杀 ──
    if (newVal === 0 && otherVal === 0) score -= 1000;

    // ── 0 倒计时压力 ──
    const myZeroTurns = action.myHand === 0 ? actor.zeroTurns0 : actor.zeroTurns1;
    if (myVal === 0 && myZeroTurns === 1) score += 20; // 必须动这个 0
    if (myVal === 0 && myZeroTurns === 1 && newVal === 0) score -= 200;

    // ── 血量调节 ──
    if (hpRatio < 0.3) {
        if (newVal === 6 || otherVal === 6) score += 30;
        if (newVal === 1 && otherVal === 1) score += 40; // 无敌
    }
    if (hpRatio > 0.7 && tHpRatio < 0.4) score += 15; // 我血多对方血少，激进

    // ── 角色专属偏好 ──
    const name = actor.name;
    if (name === '法师') {
        // 法师凑 0 价值极高
        if (newVal === 0 && otherVal > 0) score += 20;
        if (otherVal === 0 && (newVal===1||newVal===5||newVal===8||newVal===9)) score += 80;
        // 法师永远应该打人而不是补血
        if (newVal === 6 || otherVal === 6) score -= 30;
    }
    if (name === '孙悟空') {
        // [0,2] 大招优先级最高
        if ((newVal === 0 && otherVal === 2) || (newVal === 2 && otherVal === 0)) {
            if (actor.zeroTwoUses !== undefined && actor.zeroTwoUses < 3) score += 120;
        }
        // 避免双 0
        if (newVal === 0 && otherVal === 0) score -= 500;
    }
    if (name === '忍者') {
        // 忍者凑 7 / 触发毒
        if (newVal === 7 || otherVal === 7) score += 25;
        if (newVal === 7 && otherVal === 7) score += 40; // [7,7]再加成
    }
    if (name === '小乔') {
        // 小乔回血同时打人，回血组合价值高
        if (newVal === 6 || otherVal === 6) score += 25;
    }
    if (name === '藏师') {
        // 藏师凑回血/护盾
        if (newVal === 6 || otherVal === 6) score += 30;
        if (newVal === 2 || newVal === 3) score += 10;
    }
    if (name === '张飞') {
        // 张飞凑回血攒怒气；保持双手差大（免伤）
        if (newVal === 6 || otherVal === 6) score += 20;
        const handDiff = Math.abs(newVal - otherVal);
        score += handDiff * 0.5;
    }
    if (name === '大乔') {
        // 大乔靠抢血升 HP，打人触发回血也好
        if (otherVal === 0 && (newVal===1||newVal===5||newVal===8||newVal===9)) score += 30;
    }
    if (name === '鸦眼') {
        // 鸦眼有乌鸦时打人价值翻倍
        const targetHasCrow = (target.buffList || []).some(b => b.name && b.name.indexOf('乌鸦') >= 0);
        if (targetHasCrow) score += 30;
        // 鸦眼不应该补血（自残机制，回血来自打人）
        if (newVal === 6 || otherVal === 6) score -= 15;
    }
    if (name === '阴阳师') {
        // 阴阳师在阴模态时打人；阳模态时回血
        // modal 字段：'yin' / 'yang' / 'ren'
        if (actor.modal === 'yin' && (newVal === 6 || otherVal === 6)) score += 20; // 阴模态回血会转伤
    }

    // ── 凑双子星准备步（差1时给小加分）──
    if (Math.abs(newVal - otherVal) === 1 && newVal > 0 && otherVal > 0) score += 8;

    // ── 不要碰对方"即将凑双星"的手 ──
    // 比如对方 [4,5]，碰他的 4 让他变成 [4+x, 5]，反而帮他更难凑
    // 简化：对方双手差1时，碰目标手让差变大，加分
    const tOtherVal = target.hands[1 - action.touchHandIdx];
    const tNewVal = (target.hands[action.touchHandIdx] + myVal) % 10;
    if (Math.abs(tOtherVal - target.hands[action.touchHandIdx]) === 1
        && Math.abs(tOtherVal - tNewVal) > 1) score += 12;

    return score;
};

// ── 1步前瞻：模拟执行动作后的局面差值 ──
// 用 Haxe 引擎做一次 sandbox handleTouch 太重，这里用纯JS快速估算
AI.lookaheadScore = function(actorIdx, action) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const target = players[action.targetIdx];
    const dmgTargetIdx = (typeof getActualTarget === 'function') ? getActualTarget(action.targetIdx) : action.targetIdx;
    const dmgTarget = players[dmgTargetIdx];
    if (!dmgTarget) return 0;

    let bonus = 0;
    const myVal = actor.hands[action.myHand];
    const tVal = target.hands[action.touchHandIdx];
    const newVal = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];

    // 估算这次能打出多少伤害（粗略）
    let estDmg = 0;
    if (newVal === 0 && otherVal > 0 || otherVal === 0 && newVal > 0) {
        const k = (newVal === 0) ? otherVal : newVal;
        if (k===1||k===5||k===8||k===9) estDmg = 40;
        if (k===7) estDmg = 10;
    }
    if (newVal === otherVal && newVal > 0) {
        const dblDmg = {7:30, 9:160, 0:150};  // [9,9]按场上3的倍数粗估
        estDmg = Math.max(estDmg, dblDmg[newVal] || 0);
    }
    // 角色乘算
    if (actor.name === '小乔') estDmg = Math.floor(estDmg * 1.5);
    if (actor.name === '张飞' && actor.modal === 1) estDmg = Math.floor(estDmg * 1.5);

    // 估算目标实际承伤（粗略：物伤目标有物盾减半）
    const tShieldAmt = (dmgTarget.shieldList || []).reduce((s, x) => s + (x.amount || 0), 0);
    const actualDmg = Math.max(0, estDmg - tShieldAmt);
    bonus += actualDmg * 0.6;

    // 能击杀对方关键角色 → 大加分
    if (estDmg >= dmgTarget.hp && dmgTarget.hp > 0) {
        bonus += 80;  // 击杀
        // 击杀脆皮（HP < 200）更优先
        if (dmgTarget.maxHp < 250) bonus += 30;
    }

    // 这次行动会让对方拿到关键组合？惩罚
    const tHandTouched = action.touchHandIdx;
    const tOther = target.hands[1 - tHandTouched];
    const tNew = (target.hands[tHandTouched] + myVal) % 10;
    // 帮对方凑双星
    if (tNew === tOther && tNew > 0) {
        const badDoubleStar = {0:-100, 9:-60, 7:-40, 6:-30, 1:-25};
        bonus += badDoubleStar[tNew] || -10;
    }
    // 帮对方凑 0 组合
    if ((tNew === 0 && tOther > 0) || (tOther === 0 && tNew > 0)) {
        // 对方手上有 0 且我把另一只手凑出强组合数字
        if (tOther === 0 && (tNew===1||tNew===5||tNew===8||tNew===9)) bonus -= 25;
    }

    // 自己变 0 的风险（如果对方有反伤/中毒会更糟）
    if (newVal === 0) {
        bonus -= 5;
        if (actor.zeroTurns0 > 0 || actor.zeroTurns1 > 0) bonus -= 10; // 两手都0风险
    }

    return bonus;
};

// ── 调 LLM 决策 ──
AI.askLLM = async function(actorIdx, topCandidates) {
    if (!AI.knowledgeCache) await AI.loadKnowledge();
    const snapshot = AI.buildSnapshot(actorIdx);
    const candidatesText = topCandidates.map((c, i) => {
        const target = Main.turnManager.players[c.targetIdx];
        return `${i}: 用我的${c.myHand===0?'左':'右'}手(${Main.turnManager.players[actorIdx].hands[c.myHand]}) 碰 ${target.name} 的${c.touchHandIdx===0?'左':'右'}手(${target.hands[c.touchHandIdx]})`;
    }).join('\n');

    const sysPrompt = `你是指尖博弈的AI对战策略师。你需要从候选动作中选最佳的一个，并给出20字内简短理由。

【经验库】
${AI.knowledgeCache}

【回复格式】严格JSON，无任何额外文本：
{"choice": 候选编号(0-2), "reason": "20字内理由"}`;

    const userPrompt = `【当前局面】
${snapshot}

【候选动作】
${candidatesText}

请选择最优动作。`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.4,
                max_tokens: 200,
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        // 提取 JSON
        const m = content.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        return null;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
};

// ── 局面快照 ──
AI.buildSnapshot = function(actorIdx) {
    const players = Main.turnManager.players;
    const lines = [];
    lines.push(`回合: 第${Main.turnManager.turnCount}回合，轮到 ${players[actorIdx].name} 行动`);
    players.forEach((p, i) => {
        const tag = (i === actorIdx) ? '【我】' : (campOf(i) === campOf(actorIdx) ? '队友' : '敌方');
        const buffs = (p.buffList || []).filter(b => b.layers > 0).map(b => b.name).join(',') || '无';
        const shields = (p.shieldList || []).map(s => `${s.type}${s.amount}/${s.turns}回`).join(',') || '无';
        const hand0Zero = p.zeroTurns0 > 0 ? `(剩${p.zeroTurns0})` : '';
        const hand1Zero = p.zeroTurns1 > 0 ? `(剩${p.zeroTurns1})` : '';
        lines.push(`${tag} ${p.name} HP:${p.hp}/${p.maxHp} 手:[${p.hands[0]}${hand0Zero},${p.hands[1]}${hand1Zero}] Buff:${buffs} 盾:${shields}`);
    });
    return lines.join('\n');
};

// ── AI 主动开启鸦眼/张飞等技能（简单规则）──
AI.maybeUseCustomAction = function(actorIdx) {
    const actor = Main.turnManager.players[actorIdx];
    const name = actor.name;
    // 鸦眼：HP高时主动用灼燃箭（攻击型）
    if (name === '鸦眼' && actor.hp > 100 && !actor.useBurningArrow) {
        Main.invokeAction(actorIdx, 'toggleBurningArrow', {});
        if (actor.crowCount >= 6 && actor.hp > 220) {
            Main.invokeAction(actorIdx, 'toggleDemonSword', {});
        }
    }
    // 张飞：默认模态1，2v2时若敌方双存活则用模态2
    // 阴阳师：低血切阳，高血切阴（简单规则）
};

// ── 战斗结束复盘：让 LLM 提炼经验追加到知识库 ──
AI.reflectBattle = async function(winnerCamp) {
    if (!AI.enabled || AI.log.length < 3) return;
    const aiWon = (winnerCamp === AI.aiCamp);
    const summary = AI.log.slice(-20).map(l =>
        `T${l.turn} ${l.actor}[${l.actorHands.join(',')}]: ${l.reason}`
    ).join('\n');

    const sysPrompt = `你是指尖博弈的复盘分析师。基于本局战斗日志，提炼1-3条新经验规则，每条一行，简短具体。
不要重复已有规则。只输出规则文本，不要标题/编号/解释。`;
    const userPrompt = `【本局结果】AI ${aiWon ? '胜利' : '失败'}
【最近20步动作】
${summary}

【已有经验库】
${AI.knowledgeCache || ''}

提炼新经验：`;

    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.6,
                max_tokens: 300,
            }),
        });
        const data = await r.json();
        const newRules = data?.choices?.[0]?.message?.content?.trim();
        if (newRules && newRules.length > 10) {
            await fetch('/api/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ append: `## ${new Date().toLocaleString()} 复盘\n${newRules}` }),
            });
            console.log('[AI] 已追加新经验：', newRules);
            // 重新加载知识库
            AI.knowledgeCache = null;
            await AI.loadKnowledge();
        }
    } catch (e) {
        console.warn('[AI] 复盘失败：', e);
    }
};
