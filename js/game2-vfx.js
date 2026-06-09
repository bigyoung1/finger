// ════════════════════════════════════════════════════════
//  game2-vfx.js  战斗视觉特效
//
//  入口（由 game2-render.js 或 GameEngine 在关键时刻调用）：
//    VFX.slash(playerIdx, type)      — 伤害斜斩
//    VFX.heal(playerIdx, type)       — 回复浮动加号
//    VFX.shield(playerIdx, shieldType) — 护盾出现
//    VFX.screenShake()               — 屏幕震动（大伤害触发）
// ════════════════════════════════════════════════════════

window.VFX = (function () {
    var VFX = {}; // 先创建对象，方便下面 VFX.xxx = ... 赋值

    // 斩线颜色
    const SLASH_COLORS = {
        PHYSICAL: ['#ff2020', '#ff6060'],   // 物理 — 红
        MAGIC:    ['#b44fff', '#d090ff'],   // 法术 — 紫
        TRUE:     ['#e8e8ff', '#ffffff'],   // 真实 — 白
        POISON:   ['#1a8c1a', '#40c040'],   // 毒   — 黑绿
    };

    // 加号颜色
    const HEAL_COLORS = {
        RECOVERY: '#30d158', // 回复 — 绿
        SUPPLY:   '#ffd60a', // 补给 — 黄
    };

    // 护盾颜色
    const SHIELD_COLORS = {
        PHYSICAL:    { fill: '#1565C0', stroke: '#42A5F5', glow: '#1e88e5' },
        MAGIC:       { fill: '#6A1B9A', stroke: '#CE93D8', glow: '#9c27b0' },
        BOTH:        { fill: '#B71C1C', stroke: '#EF9A9A', glow: '#f44336' },
        TRUE:        { fill: '#1B5E20', stroke: '#81C784', glow: '#4caf50' },
    };

    function getCard(playerIdx) {
        return document.getElementById('card2v_' + playerIdx);
    }

    // ── 创建特效层（相对卡片绝对定位，z-index高）──
    function createLayer(card) {
        const el = document.createElement('div');
        el.style.cssText = `
            position:absolute; top:0; left:0; width:100%; height:100%;
            pointer-events:none; overflow:visible; z-index:999;
        `;
        card.appendChild(el);
        return el;
    }

    // ════════════════════════════════════════════════════
    //  斩击特效 — SVG 对角斜线，从右上到左下
    // ════════════════════════════════════════════════════
    VFX.slash = function (playerIdx, type) {
        const card = getCard(playerIdx);
        if (!card) return;

        const colors = SLASH_COLORS[type] || SLASH_COLORS.PHYSICAL;
        const [c1, c2] = colors;

        const layer = createLayer(card);
        const w = card.offsetWidth;
        const h = card.offsetHeight;

        // 两条平行斜线，略偏移
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible`;

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

        // 发光滤镜
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', `glow-${playerIdx}-${Date.now()}`);
        filter.innerHTML = `
            <feGaussianBlur stdDeviation="4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        `;
        const fid = filter.getAttribute('id');
        defs.appendChild(filter);
        svg.appendChild(defs);

        // 主斩线
        const lines = [
            { x1: w * 0.75, y1: 0, x2: w * 0.15, y2: h, color: c1, width: 4 },
            { x1: w * 0.85, y1: 0, x2: w * 0.25, y2: h, color: c2, width: 2 },
        ];

        lines.forEach(({ x1, y1, x2, y2, color, width }) => {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x1); line.setAttribute('y1', y1);
            line.setAttribute('x2', x2); line.setAttribute('y2', y2);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', width);
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('filter', `url(#${fid})`);
            const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
            line.style.cssText = `
                stroke-dasharray:${len};
                stroke-dashoffset:${len};
                animation: slash-draw 0.12s ease-out forwards;
            `;
            svg.appendChild(line);
        });

        // 闪光矩形
        const flash = document.createElement('div');
        flash.style.cssText = `
            position:absolute; top:0; left:0; width:100%; height:100%;
            background:${c1}; opacity:0;
            border-radius:8px;
            animation: slash-flash 0.15s ease-out forwards;
        `;
        layer.appendChild(flash);
        layer.appendChild(svg);

        // 自动销毁
        setTimeout(() => layer.remove(), 500);
    };

    // ════════════════════════════════════════════════════
    //  回复特效 — 多个加号从头像区上飘
    // ════════════════════════════════════════════════════
    VFX.heal = function (playerIdx, type) {
        const card = getCard(playerIdx);
        if (!card) return;

        const color = HEAL_COLORS[type] || HEAL_COLORS.RECOVERY;
        const count = 7 + Math.floor(Math.random() * 3);

        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                const el = document.createElement('div');
                const x = 15 + Math.random() * 55; // 头像区域 x%
                const y = 20 + Math.random() * 40;
                const size = 14 + Math.random() * 8;
                const dur = 900 + Math.random() * 400;
                const dy = -(30 + Math.random() * 40);

                el.textContent = '+';
                el.style.cssText = `
                    position:absolute;
                    left:${x}%; top:${y}%;
                    font-size:${size}px;
                    font-weight:900;
                    color:${color};
                    text-shadow:0 0 6px ${color}88, 0 1px 2px rgba(0,0,0,0.5);
                    pointer-events:none;
                    z-index:1000;
                    transform:translateY(0) scale(1);
                    opacity:1;
                    animation: heal-float ${dur}ms ease-out forwards;
                    --dy: ${dy}px;
                `;
                card.appendChild(el);
                setTimeout(() => el.remove(), dur + 50);
            }, i * 80);
        }
    };

    // ════════════════════════════════════════════════════
    //  护盾特效 — 盾牌 SVG 出现后渐隐（定位在头像中央）
    // ════════════════════════════════════════════════════
    VFX.shield = function (playerIdx, shieldType) {
        const card = getCard(playerIdx);
        if (!card) return;

        // 优先挂到头像容器（char-avatar-wrap），回落到整张卡片
        const avatarImg = document.getElementById('avatar_' + playerIdx);
        const avatarWrap = (avatarImg && avatarImg.parentElement) || card;
        // 确保 avatarWrap 可作为定位父元素
        const wrapPos = window.getComputedStyle(avatarWrap).position;
        if (wrapPos === 'static') avatarWrap.style.position = 'relative';

        const pal = SHIELD_COLORS[shieldType] || SHIELD_COLORS.PHYSICAL;
        const id = `shield-${playerIdx}-${Date.now()}`;

        const el = document.createElement('div');
        el.style.cssText = `
            position:absolute;
            top:50%; left:50%;
            transform:translate(-50%, -50%) scale(0);
            width:min(80%, 120px);
            aspect-ratio:1;
            pointer-events:none;
            z-index:1001;
            animation:shield-appear 2.2s ease forwards;
        `;

        el.innerHTML = `
        <svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;filter:drop-shadow(0 0 12px ${pal.glow})">
          <defs>
            <linearGradient id="${id}-g1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="${pal.stroke}"/>
              <stop offset="100%" stop-color="${pal.fill}"/>
            </linearGradient>
            <linearGradient id="${id}-g2" x1="0%" y1="0%" x2="60%" y2="100%">
              <stop offset="0%" stop-color="rgba(255,255,255,0.35)"/>
              <stop offset="100%" stop-color="rgba(255,255,255,0.05)"/>
            </linearGradient>
          </defs>
          <!-- 外层盾形 -->
          <path d="M100 8 L188 40 L188 110 Q188 175 100 212 Q12 175 12 110 L12 40 Z"
                fill="url(#${id}-g1)" stroke="${pal.stroke}" stroke-width="4"/>
          <!-- 内层高光 -->
          <path d="M100 22 L174 48 L174 108 Q174 162 100 195 Q26 162 26 108 L26 48 Z"
                fill="url(#${id}-g2)"/>
          <!-- 五角星 -->
          <polygon points="100,58 112,90 147,90 120,110 130,143 100,123 70,143 80,110 53,90 88,90"
                   fill="white" opacity="0.92"
                   style="filter:drop-shadow(0 0 4px rgba(255,255,255,0.8))"/>
          <!-- 两侧小星 -->
          <polygon points="42,75 47,88 61,88 50,96 54,109 42,101 30,109 34,96 23,88 37,88"
                   fill="white" opacity="0.55"/>
          <polygon points="158,75 163,88 177,88 166,96 170,109 158,101 146,109 150,96 139,88 153,88"
                   fill="white" opacity="0.55"/>
          <!-- 底部装饰横条 -->
          <rect x="55" y="168" width="90" height="6" rx="3" fill="white" opacity="0.4"/>
          <rect x="70" y="178" width="60" height="4" rx="2" fill="white" opacity="0.25"/>
        </svg>`;

        avatarWrap.appendChild(el);
        setTimeout(() => el.remove(), 2500);
    };

    // ════════════════════════════════════════════════════
    //  屏幕震动
    // ════════════════════════════════════════════════════
    VFX.screenShake = function (intensity) {
        intensity = intensity || 1;
        const arena = document.getElementById('battleArena2') || document.body;
        arena.style.animation = 'none';
        arena.offsetHeight; // reflow
        arena.style.animation = `screen-shake ${0.3 + intensity * 0.1}s ease forwards`;
        setTimeout(() => { arena.style.animation = ''; }, 500);
    };

    // ════════════════════════════════════════════════════
    //  Haxe 侧通知接口（applyHeal/applyRawHeal/applyDamage 调用）
    //  用队列积累，render差量对比时消费，避免多帧竞态
    // ════════════════════════════════════════════════════
    VFX._healQueue   = {};  // playerIdx → ['RECOVERY'|'SUPPLY', ...]
    VFX._damageQueue = {};  // playerIdx → ['PHYSICAL'|'MAGIC'|'TRUE'|'POISON', ...]
    VFX._lastHealTypes = {}; // 兼容旧代码

    VFX.notifyHeal = function(playerIdx, healType) {
        if (!VFX._healQueue[playerIdx]) VFX._healQueue[playerIdx] = [];
        VFX._healQueue[playerIdx].push(healType);
        VFX._lastHealTypes[playerIdx] = healType;
    };

    VFX.notifyDamage = function(playerIdx, damageType) {
        if (!VFX._damageQueue[playerIdx]) VFX._damageQueue[playerIdx] = [];
        VFX._damageQueue[playerIdx].push(damageType);
    };

    // ════════════════════════════════════════════════════
    //  注入 CSS keyframes（只注一次）
    // ════════════════════════════════════════════════════
    (function injectStyles() {
        if (document.getElementById('vfx-styles')) return;
        const style = document.createElement('style');
        style.id = 'vfx-styles';
        style.textContent = `
            @keyframes slash-draw {
                from { stroke-dashoffset: var(--len, 1000); opacity: 1; }
                80%  { opacity: 1; }
                to   { stroke-dashoffset: 0; opacity: 0; }
            }
            @keyframes slash-flash {
                0%   { opacity: 0.45; }
                30%  { opacity: 0.25; }
                100% { opacity: 0; }
            }
            @keyframes heal-float {
                0%   { transform: translateY(0) scale(1);    opacity: 1; }
                60%  { transform: translateY(calc(var(--dy) * 0.7)) scale(1.15); opacity: 0.9; }
                100% { transform: translateY(var(--dy)) scale(0.8); opacity: 0; }
            }
            @keyframes shield-appear {
                0%   { transform: translate(-50%,-55%) scale(0);   opacity: 0; }
                18%  { transform: translate(-50%,-55%) scale(1.15); opacity: 1; }
                28%  { transform: translate(-50%,-55%) scale(0.95); opacity: 1; }
                38%  { transform: translate(-50%,-55%) scale(1.05); opacity: 1; }
                50%  { transform: translate(-50%,-55%) scale(1);    opacity: 1; }
                75%  { transform: translate(-50%,-55%) scale(1);    opacity: 0.7; }
                100% { transform: translate(-50%,-55%) scale(0.9);  opacity: 0; }
            }
            @keyframes screen-shake {
                0%   { transform: translate(0,0) rotate(0deg); }
                15%  { transform: translate(-5px, 3px) rotate(-0.4deg); }
                30%  { transform: translate(5px, -3px) rotate(0.4deg); }
                45%  { transform: translate(-3px, 4px) rotate(-0.2deg); }
                60%  { transform: translate(3px, -2px) rotate(0.2deg); }
                75%  { transform: translate(-2px, 1px) rotate(0deg); }
                100% { transform: translate(0,0) rotate(0deg); }
            }
        `;
        document.head.appendChild(style);
    })();

    return VFX;

})();
