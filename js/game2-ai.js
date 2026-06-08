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
        c.heuristicScore = AI.scoreActionHeuristic(actorIdx, c);
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

    // 凑双子星
    if (newVal === otherVal && newVal > 0) {
        score += 50; // 通用
        if (newVal === 9) score += 50;
        if (newVal === 7) score += 30;
        if (newVal === 0) score += 80; // 双0真伤
    }
    // 凑 [0,x]
    if (newVal === 0 && otherVal > 0) score += 30;
    if (otherVal === 0 && newVal > 0) {
        // 完成 0组合
        if (newVal === 1 || newVal === 5 || newVal === 8 || newVal === 9) score += 35;
        if (newVal === 6) score += 25;
    }
    // 自杀惩罚（双0立即死）
    if (newVal === 0 && otherVal === 0) score -= 1000;
    // 0倒计时压力
    const myZeroTurns = action.myHand === 0 ? actor.zeroTurns0 : actor.zeroTurns1;
    if (myVal === 0 && myZeroTurns === 1 && newVal === 0) score -= 200;
    // HP 压力：低血时偏好回血
    if (actor.hp < actor.maxHp * 0.3) {
        if (newVal === 6 || otherVal === 6) score += 20;
    }
    return score;
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
