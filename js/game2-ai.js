// ════════════════════════════════════════════════════════
//  game2-ai.js  v2  双LLM + 主动技能 + 角色文档
// ════════════════════════════════════════════════════════

window.AI = {
    enabled: false,
    aiCamp: 'rebel',
    knowledgeCache: null,
    skillCache: {},         // { '法师': '...', '鸦眼': '...' }
    thinkingPromise: null,
    log: [],
    // 每个 AI 角色分配不同 provider
    // playerIdx → provider
    providerMap: {},
};

AI.start = function(aiCamp) {
    AI.enabled = true;
    AI.aiCamp = aiCamp || 'rebel';
    AI.log = [];
    AI.providerMap = {};
    // 分配 provider：同队两个角色一个用 minimax 一个用 deepseek
    const seats = aiCamp === 'rebel' ? [1, 3] : [0, 2];
    AI.providerMap[seats[0]] = 'minimax';
    AI.providerMap[seats[1]] = 'deepseek';
    console.log('[AI] Provider map:', AI.providerMap);
    AI.loadKnowledge();
};

AI.stop = function() { AI.enabled = false; AI.thinkingPromise = null; };

// ── 知识库 ──
AI.loadKnowledge = async function() {
    try {
        const r = await fetch('/api/knowledge');
        AI.knowledgeCache = await r.text();
    } catch(e) { AI.knowledgeCache = ''; }
};

// ── 角色技能文档 ──
AI.loadSkill = async function(name) {
    if (AI.skillCache[name]) return AI.skillCache[name];
    try {
        const r = await fetch('/api/skill?name=' + encodeURIComponent(name));
        const txt = await r.text();
        AI.skillCache[name] = txt;
        return txt;
    } catch(e) { return ''; }
};

// ── render2 后检查是否轮到 AI ──
AI.checkAndAct = function() {
    if (!AI.enabled || AI.thinkingPromise) return;
    if (!Main.turnManager || Main.turnManager.gameOver) return;
    if (G.inputLocked || G.helpTankContext || G.wukongPending) return;
    const curIdx = Main.turnManager.currentPlayerIdx;
    if (campOf(curIdx) !== AI.aiCamp) return;
    AI.thinkingPromise = AI.takeTurn(curIdx).finally(() => { AI.thinkingPromise = null; });
};

// ── AI 行动主流程 ──
AI.takeTurn = async function(actorIdx) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    setHint2('🤖 ' + actor.name + ' 思考中...');

    // 1. 主动技能决策（攻击前）
    AI.decideActiveSkills(actorIdx);

    // 2. 枚举合法攻击动作
    const candidates = AI.enumerateLegalActions(actorIdx);
    if (candidates.length === 0) { finishTurn2(); return; }

    // 3. 启发式打分 + lookahead，取 top-4
    candidates.forEach(c => {
        c.score = AI.scoreAction(actorIdx, c);
    });
    candidates.sort((a, b) => b.score - a.score);
    const top4 = candidates.slice(0, 4);

    // 4. 加载角色技能文档（异步，不阻塞）
    const skillDoc = await AI.loadSkill(actor.name);

    // 5. 调对应 provider 的 LLM（15%概率探索：随机选非最优）
    let chosen = top4[0];
    let reason = '启发式';

    // 探索机制：15%概率跳过LLM，随机选第2或第3候选
    if (Math.random() < 0.15 && top4.length > 1) {
        const pick = 1 + Math.floor(Math.random() * Math.min(2, top4.length - 1));
        chosen = top4[pick];
        reason = `探索(#${pick})`;
    } else {
        try {
            const provider = AI.providerMap[actorIdx] || 'minimax';
            const result = await AI.askLLM(actorIdx, top4, skillDoc, provider);
            if (result && typeof result.choice === 'number') {
                const idx = Math.max(0, Math.min(top4.length-1, result.choice));
                chosen = top4[idx];
                reason = `[${provider}] ${result.reason || ''}`;
            }
        } catch(e) {
            console.warn('[AI] LLM failed, using heuristic:', e);
        }
    }

    AI.log.push({ turn: Main.turnManager.turnCount, actor: actor.name, reason });

    setHint2('🤖 ' + actor.name + ': ' + reason.slice(0, 30));
    const dmgTargetIdx = getActualTarget(chosen.targetIdx);
    doAttack2(actorIdx, chosen.myHand, chosen.targetIdx, chosen.touchHandIdx, dmgTargetIdx);
};

// ════════════════════════════════════════════════════
//  主动技能决策（攻击前自动触发）
// ════════════════════════════════════════════════════
AI.decideActiveSkills = function(actorIdx) {
    const actor = Main.turnManager.players[actorIdx];
    const name = actor.name;
    const hpRatio = actor.hp / (actor.maxHp || 1);

    if (name === '鸦眼') {
        // 灼燃箭：HP > 80 或有乌鸦 buff 加成时开启
        if (!actor.useBurningArrow && actor.hp > 80) {
            Main.invokeAction(actorIdx, 'toggleBurningArrow', {});
        }
        // 魔王剑：灼燃开启 + 乌鸦 >= 6 + HP 充足
        if (actor.useBurningArrow && actor.crowCount >= 6 && actor.hp > 150) {
            Main.invokeAction(actorIdx, 'toggleDemonSword', {});
        }
    }

    if (name === '张飞') {
        // 2v2 时模态2：如果对面两个人都活着
        const enemies = Main.turnManager.players.filter(
            (p, i) => campOf(i) !== AI.aiCamp && p.hp > 0
        );
        const modal = actor.modal || 1;
        if (enemies.length >= 2 && modal !== 2) {
            Main.invokeAction(actorIdx, 'setModal', { modal: 2 });
        } else if (enemies.length < 2 && modal === 2) {
            Main.invokeAction(actorIdx, 'setModal', { modal: 1 });
        }
        // 模态3：HP < 40%，打人同时回血
        if (hpRatio < 0.4 && modal !== 3) {
            Main.invokeAction(actorIdx, 'setModal', { modal: 3 });
        }
    }

    if (name === '阴阳师') {
        // 阳模态：HP < 35%；阴模态：HP > 65%；其余人模态
        const modal = actor.modal || 'ren';
        if (hpRatio < 0.35 && modal !== 'yang') {
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'yang' });
        } else if (hpRatio > 0.65 && modal !== 'yin') {
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'yin' });
        } else if (hpRatio >= 0.35 && hpRatio <= 0.65 && modal !== 'ren') {
            Main.invokeAction(actorIdx, 'switchModal', { modal: 'ren' });
        }
    }

    if (name === '鸦眼') {
        // 乌鸦诅咒：没有乌鸦 buff 且 HP > 60 时自动对对方全队施加
        const enemies = Main.turnManager.players.filter(
            (p, i) => campOf(i) !== AI.aiCamp && p.hp > 0
        );
        const enemyHasCrow = enemies.some(p =>
            (p.buffList || []).some(b => b.id === 'CROW')
        );
        if (!enemyHasCrow && actor.hp > 60) {
            // 对敌方施加乌鸦诅咒
            Main.invokeAction(actorIdx, 'crowCurseTarget', { camp: 'enemy' });
        }
    }
};

// ════════════════════════════════════════════════════
//  枚举合法动作
// ════════════════════════════════════════════════════
AI.enumerateLegalActions = function(actorIdx) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const result = [];
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

// ════════════════════════════════════════════════════
//  综合打分 = 启发式 + lookahead
// ════════════════════════════════════════════════════
AI.scoreAction = function(actorIdx, action) {
    return AI.scoreHeuristic(actorIdx, action) + AI.lookahead(actorIdx, action);
};

AI.scoreHeuristic = function(actorIdx, action) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const target = players[action.targetIdx];
    if (!target) return 0;

    const myVal    = actor.hands[action.myHand];
    const tVal     = target.hands[action.touchHandIdx];
    const newVal   = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    const hpR      = actor.hp / (actor.maxHp || 1);
    const tHpR     = target.hp / (target.maxHp || 1);
    let score = 0;

    // ── 双子星（差异化权重）──
    if (newVal === otherVal && newVal > 0) {
        const w = {0:150, 9:110, 7:80, 6:70, 4:45, 5:40, 8:35, 1:45, 2:10, 3:10};
        score += w[newVal] || 15;
    }

    // ── 凑 0：高权重 ──
    if (newVal === 0 && otherVal > 0) score += 55;   // 凑出 0（另一只手有数字，可做组合）
    if (newVal === 0 && otherVal === 0) score -= 999; // 双零自杀

    // ── 完成 [0,x] 组合：最高优先级 ──
    if (otherVal === 0 && newVal > 0) {
        const bonus = {1:90, 5:90, 8:90, 9:90, 6:55, 4:50, 7:35, 2:20, 3:20};
        score += bonus[newVal] || 10;
        // 法师加算：0组合收益翻倍
        if (actor.name === '法师') score += bonus[newVal] || 10;
    }

    // ── 0 倒计时压力 ──
    const myZT = action.myHand === 0 ? actor.zeroTurns0 : actor.zeroTurns1;
    if (myVal === 0 && myZT <= 1) score += 30;

    // ── [x,6] 回血 ──
    if (newVal === 6 || otherVal === 6) {
        const healBonus = hpR < 0.35 ? 45 : (hpR < 0.6 ? 20 : 5);
        score += healBonus;
        if (actor.name === '法师') score -= 20; // 法师不回血
        if (actor.name === '鸦眼') score -= 15;
    }

    // ── 角色专属 ──
    switch (actor.name) {
        case '法师':
            if (otherVal === 0 && (newVal===1||newVal===5||newVal===8||newVal===9)) score += 60;
            if (newVal === 6 || otherVal === 6) score -= 35;
            break;
        case '孙悟空':
            if ((newVal===0&&otherVal===2)||(newVal===2&&otherVal===0)) {
                if ((actor.zeroTwoUses||0) < 3) score += 140;
            }
            break;
        case '忍者':
            if (newVal === 7 || otherVal === 7) score += 30;
            if (newVal === 7 && otherVal === 7) score += 35;
            break;
        case '张飞':
            // 保持双手差大（免伤）
            score += Math.abs(newVal - otherVal) * 1.5;
            break;
        case '大乔':
            if (otherVal===0&&(newVal===1||newVal===5||newVal===8||newVal===9)) score += 35;
            break;
        case '鸦眼':
            // 对方有乌鸦 buff 时打人价值很高
            const hasCrow = (target.buffList||[]).some(b=>b.id==='CROW'&&b.layers>0);
            if (hasCrow) score += 50;
            break;
    }

    // ── 接近双子星（差1，辅助布局）──
    if (Math.abs(newVal - otherVal) === 1 && newVal > 0 && otherVal > 0) score += 6;

    // ── 激进/保守调节 ──
    if (hpR > 0.7 && tHpR < 0.35) score += 12;

    return score;
};

AI.lookahead = function(actorIdx, action) {
    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const target = players[action.targetIdx];
    const dmgIdx = (typeof getActualTarget==='function') ? getActualTarget(action.targetIdx) : action.targetIdx;
    const dmgTarget = players[dmgIdx];
    if (!dmgTarget) return 0;

    const myVal  = actor.hands[action.myHand];
    const tVal   = target.hands[action.touchHandIdx];
    const newVal = (myVal + tVal) % 10;
    const otherVal = actor.hands[1 - action.myHand];
    let bonus = 0;

    // 估算输出伤害
    let estDmg = 0;
    if (otherVal===0 && newVal>0) {
        const t={1:40,5:40,8:40,9:40,7:10}; estDmg = t[newVal]||0;
    }
    if (newVal===otherVal&&newVal>0) {
        const t={9:200,0:150,7:40,6:0}; estDmg = Math.max(estDmg, t[newVal]||0);
    }
    if (actor.name==='小乔') estDmg = Math.floor(estDmg*1.5);
    if (actor.name==='张飞') estDmg = Math.floor(estDmg*(actor.modal===1?1.5:actor.modal===2?0.75:1));

    const shTotal = (dmgTarget.shieldList||[]).reduce((s,x)=>s+(x.amount||0),0);
    bonus += Math.max(0, estDmg - shTotal) * 0.5;

    // 击杀奖励
    if (estDmg >= dmgTarget.hp && dmgTarget.hp > 0) {
        bonus += 90;
        if ((dmgTarget.maxHp||999) < 250) bonus += 25;
    }

    // 我动完对方双手变危险（帮对方凑双星/完成0组合）
    const tOther  = target.hands[1 - action.touchHandIdx];
    const tNewVal = (target.hands[action.touchHandIdx] + myVal) % 10;
    if (tNewVal === tOther && tNewVal > 0) {
        const bad={0:-120,9:-70,7:-50,6:-40,1:-30}; bonus += bad[tNewVal]||(-15);
    }
    if ((tNewVal===0&&tOther>0)||(tOther===0&&(tNewVal===1||tNewVal===5||tNewVal===8||tNewVal===9))) {
        bonus -= 40;
    }

    return bonus;
};

// ════════════════════════════════════════════════════
//  LLM 调用（支持 provider 切换）
// ════════════════════════════════════════════════════
AI.askLLM = async function(actorIdx, top4, skillDoc, provider) {
    if (!AI.knowledgeCache) await AI.loadKnowledge();

    const players = Main.turnManager.players;
    const actor = players[actorIdx];
    const snapshot = AI.buildSnapshot(actorIdx);

    const candidatesText = top4.map((c, i) => {
        const t = players[c.targetIdx];
        return `${i}: 我的${c.myHand===0?'左':'右'}手(${actor.hands[c.myHand]}) → 碰 ${t.name} 的${c.touchHandIdx===0?'左':'右'}手(${t.hands[c.touchHandIdx]}) [启发式${c.score.toFixed(0)}分]`;
    }).join('\n');

    const sysPrompt = `你是指尖博弈AI对战策略师，控制${actor.name}。从候选动作选最优一个。
严格JSON回复（无其他文字）：{"choice":编号0-${top4.length-1},"reason":"15字内"}

【经验库】\n${(AI.knowledgeCache||'').slice(0, 800)}
${skillDoc ? `\n【${actor.name}专属攻略】\n${skillDoc.slice(0, 600)}` : ''}`;

    const userPrompt = `【局面】\n${snapshot}\n\n【候选动作（启发式预排序）】\n${candidatesText}\n\n选择：`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: provider,
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.35,
                max_tokens: 120,
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const m = content.match(/\{[\s\S]*?\}/);
        if (m) return JSON.parse(m[0]);
        return null;
    } catch(e) {
        clearTimeout(timer);
        throw e;
    }
};

// ── 局面快照 ──
AI.buildSnapshot = function(actorIdx) {
    const players = Main.turnManager.players;
    const lines = [`回合:${Main.turnManager.turnCount} 行动:${players[actorIdx].name}`];
    players.forEach((p, i) => {
        const tag = i===actorIdx?'【我】': campOf(i)===campOf(actorIdx)?'友':'敌';
        const buffs = (p.buffList||[]).filter(b=>b.layers>0).map(b=>b.name).join(',') || '无';
        const sh = (p.shieldList||[]).map(s=>s.amount).reduce((a,b)=>a+b,0);
        lines.push(`${tag}${p.name} HP:${p.hp} 手:[${p.hands}] 盾:${sh} Buff:${buffs}`);
    });
    return lines.join('\n');
};

// ── 战斗复盘 ──
AI.reflectBattle = async function(winnerCamp) {
    if (!AI.enabled || AI.log.length < 3) return;
    const aiWon = winnerCamp === AI.aiCamp;
    const summary = AI.log.slice(-15).map(l=>`T${l.turn} ${l.actor}: ${l.reason}`).join('\n');
    try {
        const r = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'deepseek', // 复盘用 DeepSeek（便宜）
                messages: [
                    { role: 'system', content: '你是指尖博弈复盘师。读对战日志提炼1-2条新经验，每条一行，具体可操作，不重复已有规则，只输出规则文本。' },
                    { role: 'user', content: `AI${aiWon?'胜':'败'}\n${summary}\n已有规则:\n${(AI.knowledgeCache||'').slice(0,400)}\n新经验:` }
                ],
                temperature: 0.5, max_tokens: 200,
            }),
        });
        const data = await r.json();
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
