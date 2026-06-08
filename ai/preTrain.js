// ════════════════════════════════════════════════════════
//  ai/preTrain.js  AI 离线学习 — 让 LLM 读完所有历史日志
//  
//  用法：
//    node ai/preTrain.js                 扫描 ./log 下所有 .txt 日志
//    node ai/preTrain.js --dir=path      指定日志目录
//    node ai/preTrain.js --reset         重置 knowledge.md 为初始版
//    node ai/preTrain.js --batch=5       每批送 N 局给 LLM（默认 3）
//
//  原理：
//    1. 读所有日志文件，每个解析为"对战记录"
//    2. 分批发给 MiniMax-M2.7，让它提炼经验追加到 knowledge.md
//    3. 每批后短暂等待避免触发速率限制
// ════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args = process.argv.slice(2);
const argDir   = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '../log';
const argBatch = parseInt((args.find(a => a.startsWith('--batch=')) || '--batch=3').split('=')[1], 10);
const argReset = args.includes('--reset');

const LOG_DIR     = path.resolve(argDir);
const KB_PATH     = path.resolve(__dirname, 'knowledge.md');
const KB_INIT_PATH = path.resolve(__dirname, 'knowledge.init.md');

// ── 读 API key ──
function getApiKey() {
    if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
    const f = path.join(os.homedir(), '.minimax_api_key');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    console.error('❌ No API key. Set MINIMAX_API_KEY or ~/.minimax_api_key');
    process.exit(1);
}

// ── 调 MiniMax ──
async function callLLM(system, user) {
    const r = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + getApiKey(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'MiniMax-M2.7',
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            max_tokens: 800,
            temperature: 0.4,
        })
    });
    const data = await r.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data?.choices?.[0]?.message?.content?.trim() || '';
}

// ── 解析单个日志文件，提取关键信息 ──
function parseLog(filepath) {
    const text = fs.readFileSync(filepath, 'utf8');
    const lines = text.split('\n');
    const filename = path.basename(filepath);

    // 提取阵容
    const lineupMatch = text.match(/对战开始！\[([^\]]+)\]\s*VS\s*\[([^\]]+)\]/);
    const hero  = lineupMatch ? lineupMatch[1] : '?';
    const rebel = lineupMatch ? lineupMatch[2] : '?';

    // 找出最后存活方
    const lastSnap = lines.filter(l => l.includes('全场状态')).pop();
    // 数胜负：最后阵亡描述
    const deathLines = lines.filter(l => l.includes('已阵亡') || l.includes('死亡'));
    
    // 总回合数
    const turns = lines.filter(l => l.match(/T\d+\] 🔄 \[大回合结束/)).length;

    // 关键事件：双子星触发、击杀、大招
    const keyEvents = lines.filter(l =>
        l.includes('凑齐【') ||
        l.includes('破军组合') ||
        l.includes('医术组合') ||
        l.includes('御守组合') ||
        l.includes('狂暴') ||
        l.includes('阵亡') ||
        l.includes('帮抗')
    ).slice(0, 40); // 最多40行关键事件

    return {
        filename: filename,
        hero: hero,
        rebel: rebel,
        turns: turns,
        keyEvents: keyEvents,
        rawTailLines: lines.slice(-15), // 最后15行（含胜负）
    };
}

// ── 处理一批日志 ──
async function processBatch(batch, oldKb) {
    const summary = batch.map((b, i) => {
        return `=== 对局 ${i+1}：[${b.hero}] vs [${b.rebel}]（${b.turns}回合） — ${b.filename} ===\n` +
               b.keyEvents.join('\n') + '\n' +
               '【结束阶段】\n' + b.rawTailLines.join('\n');
    }).join('\n\n');

    const system = `你是指尖博弈对战策略分析师。任务：读完玩家的历史对战日志，提炼3-5条可操作的对战经验追加到知识库。

要求：
- 每条规则一行，简短具体，避免笼统废话（如"血少要回血"这种不要）
- 必须基于本批日志中的真实场景，引用具体角色/数字/组合
- 不要重复已有知识库里的规则
- 规则形式：条件 → 行动。例如"对手是法师+鸦眼组合时，优先压杀法师（HP低）"
- 输出格式：每行一条规则，不要标题/编号/解释，纯文本`;

    const user = `【已有知识库】\n${oldKb}\n\n【本批对战日志】\n${summary}\n\n提炼新经验：`;

    return await callLLM(system, user);
}

// ── 主流程 ──
(async () => {
    if (argReset && fs.existsSync(KB_INIT_PATH)) {
        fs.copyFileSync(KB_INIT_PATH, KB_PATH);
        console.log('✅ knowledge.md 已重置为初始版本');
    } else if (argReset) {
        console.log('⚠️ 没找到 knowledge.init.md，跳过重置');
    }

    if (!fs.existsSync(LOG_DIR)) {
        console.error(`❌ 日志目录不存在: ${LOG_DIR}`);
        process.exit(1);
    }

    // 备份当前知识库为初始版
    if (!fs.existsSync(KB_INIT_PATH) && fs.existsSync(KB_PATH)) {
        fs.copyFileSync(KB_PATH, KB_INIT_PATH);
        console.log('📋 当前 knowledge.md 已备份为 knowledge.init.md');
    }

    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.txt')).sort();
    console.log(`📚 找到 ${files.length} 个日志文件`);
    if (files.length === 0) return;

    const parsed = files.map(f => parseLog(path.join(LOG_DIR, f)));

    // 分批
    const batches = [];
    for (let i = 0; i < parsed.length; i += argBatch) {
        batches.push(parsed.slice(i, i + argBatch));
    }
    console.log(`🔢 分 ${batches.length} 批处理（每批 ${argBatch} 局）`);

    let kb = fs.existsSync(KB_PATH) ? fs.readFileSync(KB_PATH, 'utf8') : '';

    for (let i = 0; i < batches.length; i++) {
        console.log(`\n[${i+1}/${batches.length}] 处理批次（${batches[i].map(b=>b.filename).join(', ').slice(0,80)}...）`);
        try {
            const newRules = await processBatch(batches[i], kb);
            if (newRules && newRules.length > 10) {
                const header = `\n\n## 从历史日志提炼 (批次 ${i+1}, ${new Date().toLocaleString()})\n`;
                fs.appendFileSync(KB_PATH, header + newRules);
                kb += header + newRules;
                console.log(`✅ 追加 ${newRules.split('\n').length} 条新规则:\n${newRules.split('\n').slice(0,3).map(l=>'   '+l).join('\n')}`);
            } else {
                console.log('⚠️ 本批 LLM 未返回有效规则');
            }
        } catch (e) {
            console.error(`❌ 批次 ${i+1} 失败:`, e.message);
        }
        // 节流：每批间隔 2 秒避免速率限制
        if (i < batches.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n🎉 离线学习完成！knowledge.md 已更新');
    console.log(`📊 当前知识库大小: ${fs.statSync(KB_PATH).size} 字节`);
})();
