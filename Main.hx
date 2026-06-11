package;

import model.Player;
import model.Camp;
import js.Browser;

@:keep
@:expose // 🌟 极其重要：确保加了这一行，外面的 HTML 才能通过 Main.doTouch 顺利调用到它！
class Main {
    // 实例化核心控制器
    public static var engine:GameEngine = new GameEngine();
    public static var turnManager:TurnManager = new TurnManager();

    // 完整日志缓冲（用于下载）
    public static var logBuffer:Array<String> = [];

    /**
     * 供 JS 侧设置抗伤位解析器（GameEngine 在 IIFE 内，外部无法直接访问静态变量）
     * JS 调用：Main.setTankResolver(fn) / Main.setTankResolver(null)
     */
    @:keep public static function setTankResolver(fn:Dynamic):Void {
        GameEngine.tankResolver = fn;
    }

    public static function main() {
        // 【关键】把 TurnManager 注入到 GameEngine，让 [9,9] 等技能能扫描全场玩家
        engine.setTurnManager(turnManager);

        // 【新增】从 CharacterRegistry 动态填充角色下拉列表
        populateCharacterSelects();

        // 绑定页面"开始游戏"按钮
        var startBtn = Browser.document.getElementById("startBtn");
        if (startBtn != null) {
            startBtn.onclick = function() {
                setupAndStart();
            };
        }

        var endTurnBtn = Browser.document.getElementById("endTurnBtn");
        if (endTurnBtn != null) {
            endTurnBtn.onclick = function() {
                turnManager.nextTurn();
                render();
            };
        }

        // 绑定"结束并下载日志"按钮
        var endGameBtn = Browser.document.getElementById("endGameBtn");
        if (endGameBtn != null) {
            endGameBtn.onclick = function() {
                endGameAndDownload();
            };
        }

        // 重定向 Haxe 的 trace 系统的输出
        // 优先写入 logPanel2（2v2页面），找不到再写 logPanel（1v1页面）
        haxe.Log.trace = function(v:Dynamic, ?infos:haxe.PosInfos) {
            var text:String = Std.string(v);
            var timestamp = '[T${turnManager.turnCount}]';
            logBuffer.push(timestamp + ' ' + text);

            var panel = Browser.document.getElementById("logPanel2");
            if (panel == null) panel = Browser.document.getElementById("logPanel");
            if (panel != null) {
                var line = Browser.document.createElement("div");
                line.className = "log-line";
                if (text.indexOf("🎉") != -1 || text.indexOf("🏆") != -1 || text.indexOf("⚠️") != -1) {
                    line.className = "log-line log-important";
                }
                line.innerText = text;
                panel.appendChild(line);
                panel.scrollTop = panel.scrollHeight;
            }
        };
    }

    /**
     * 生成大回合末的全场状态快照（写入日志）
     */
    public static function snapshotState() {
        var lines = ['', '📸 ═══ 第 ${turnManager.turnCount} 回合后全场状态 ═══'];
        for (p in turnManager.players) {
            var parts:Array<String> = [];
            parts.push('[${p.camp}]${p.name}');
            parts.push('HP:${p.hp}');
            parts.push('双手:[${p.hands[0]},${p.hands[1]}]');
            
            if (p.zeroTurns0 > 0) parts.push('左0剩${p.zeroTurns0}回合');
            if (p.zeroTurns1 > 0) parts.push('右0剩${p.zeroTurns1}回合');
            
            if (p.buffList.length > 0) {
                var buffStr = "Buff:";
                for (b in p.buffList) buffStr += '[${b.name}x${b.layers}]';
                parts.push(buffStr);
            }
            if (p.shieldList.length > 0) {
                var sStr = "护盾:";
                for (s in p.shieldList) {
                    var typeName = switch (s.type) {
                        case PHYSICAL: "物理";
                        case MAGIC: "法术";
                        case BOTH_PHYSICAL_MAGIC: "物法";
                        case TRUE: "真实";
                    };
                    sStr += '[${typeName}盾${s.amount}/${s.duration}回合]';
                }
                parts.push(sStr);
            }

            // 角色特殊状态（由角色自描述）
            var extras = p.getSnapshotExtras();
            for (e in extras) parts.push(e);

            lines.push('  ' + parts.join(' | '));
        }
        lines.push('═════════════════════════════════════════');
        for (l in lines) trace(l);
    }

    /**
     * 结束游戏并下载日志文件
     */
    public static function endGameAndDownload() {
        if (turnManager.players.length == 0) return;
        
        var names:Array<String> = [];
        for (p in turnManager.players) names.push(p.name);
        
        // 在日志末尾加最终状态
        trace('');
        trace('🏁 ═══ 游戏结束 ═══');
        snapshotState();
        if (turnManager.winningCamp != null) {
            trace('🏆 获胜阵营：${turnManager.winningCamp}');
        }

        // 生成文件名：log_姓名1_vs_姓名2_时间.txt
        var dateStr = Date.now().toString().split(" ").join("_").split(":").join("-");
        var fileName = 'log_' + names.join('_vs_') + '_' + dateStr + '.txt';
        var content = logBuffer.join("\n");

        // 触发浏览器下载
        var blob = new js.html.Blob([content], { type: "text/plain;charset=utf-8" });
        var url = js.html.URL.createObjectURL(blob);
        var a:Dynamic = Browser.document.createElement("a");
        a.href = url;
        a.download = fileName;
        Browser.document.body.appendChild(a);
        a.click();
        Browser.document.body.removeChild(a);
        js.html.URL.revokeObjectURL(url);

        // 清空日志缓冲和UI日志
        logBuffer = [];
        var logPanel = Browser.document.getElementById("logPanel");
        if (logPanel != null) logPanel.innerHTML = '<div class="log-line">日志已下载，等待新游戏开始...</div>';

        // 重置游戏
        turnManager.gameOver = true;
        Browser.document.getElementById("setupPanel").style.display = "flex";
        Browser.document.getElementById("battleArena").style.display = "none";
        Browser.document.getElementById("turnIndicator").style.display = "none";
        Browser.document.getElementById("actionPanel").style.display = "none";
    }

    /**
     * 读取前端选择，激活对应的两个角色开启 1v1 测试
     */
    public static function setupAndStart() {
        var heroSelect:Dynamic = Browser.document.getElementById("heroSelect");
        var rebelSelect:Dynamic = Browser.document.getElementById("rebelSelect");

        // 通过工厂方法创建角色（根据 select.value 决定是白板还是小乔）
        var p1 = createCharacter(heroSelect.value, Camp.HERO);
        var p2 = createCharacter(rebelSelect.value, Camp.REBEL);

        // 2. 将选好的 1v1 玩家数组塞入阵营轮转器中
        var activePlayers = [p1, p2];
        turnManager.setupGame(activePlayers);

        // 3. 展现隐藏的对决前端面板
        Browser.document.getElementById("turnIndicator").style.display = "block";
        Browser.document.getElementById("battleArena").style.display = "flex";
        Browser.document.getElementById("actionPanel").style.display = "block";
        Browser.document.getElementById("setupPanel").style.display = "none";

        trace('⚔️ =================================== ⚔️');
        trace('⚔️ 宿命的对决已开辟！[${p1.name}] VS [${p2.name}]');
        
        render();
    }

    /**
     * 角色工厂：根据选择值返回对应英雄实例
     */
    private static function createCharacter(id:String, camp:Camp):Player {
        return character.CharacterRegistry.createCharacter(id, camp);
    }

    /**
     * 供2v2前端调用：返回所有角色选项 [{id, displayName}]
     */
    public static function getCharacterOptions():Array<Dynamic> {
        var opts = character.CharacterRegistry.getAllOptions();
        var result:Array<Dynamic> = [];
        for (o in opts) result.push({ id: o.id, displayName: o.displayName });
        return result;
    }

    /**
     * 供2v2前端调用：创建角色并返回（通过 setupGame2v2 批量初始化）
     */
    public static function setupGame2v2(id0:String, id1:String, id2:String, id3:String):Void {
        var p0 = createCharacter(id0, Camp.HERO);
        var p1 = createCharacter(id1, Camp.REBEL);
        var p2 = createCharacter(id2, Camp.HERO);
        var p3 = createCharacter(id3, Camp.REBEL);
        engine.setTurnManager(turnManager);
        turnManager.setupGame([p0, p1, p2, p3]);
        trace('⚔️ 2v2 对战开始！[${p0.name}+${p2.name}] VS [${p1.name}+${p3.name}]');
    }

    /**
     * 从 CharacterRegistry 动态填充两个角色下拉框
     */
    private static function populateCharacterSelects() {
        var options = character.CharacterRegistry.getAllOptions();
        for (selectId in ["heroSelect", "rebelSelect"]) {
            var sel:Dynamic = Browser.document.getElementById(selectId);
            if (sel == null) continue;
            sel.innerHTML = "";
            for (opt in options) {
                var optionElem:Dynamic = Browser.document.createElement("option");
                optionElem.value = opt.id;
                optionElem.text = opt.displayName;
                sel.appendChild(optionElem);
            }
        }
    }

    /**
     * 由前端调用：藏师释放草莓蛋糕
     * @param actorIdx 藏师在 players 数组中的索引
     * @param targetIdx 目标在 players 数组中的索引
     * @param groupCount 释放几组（每组消耗3个蛋糕，造成10法伤+10补给）
     */
    /**
     * 通用动作派发入口：前端调用任何角色技能都走这里
     * 用法：Main.invokeAction(actorIdx, "useCake", {targetIdx:1, groupCount:1})
     */
    public static function invokeAction(actorIdx:Int, actionName:String, params:Dynamic):String {
        if (turnManager.gameOver) return "游戏已结束";
        if (actorIdx < 0 || actorIdx >= turnManager.players.length) return "错误：玩家索引无效";
        var actor = turnManager.players[actorIdx];
        var result = actor.handleAction(actionName, params, engine);
        turnManager.checkGameOver();
        // 2v2页面用 render2()，1v1页面用 render()
        js.Syntax.code("if(typeof render2 === 'function' && document.getElementById('battleArena2')) { render2(); } else { render(); }");
        return result;
    }

    // ─────────────────────────────────────────────────────────────
    // AI对战入口
    // ─────────────────────────────────────────────────────────────

    public static function useCake(actorIdx:Int, targetIdx:Int, groupCount:Int):String {
        return invokeAction(actorIdx, "useCake", { targetIdx: targetIdx, groupCount: groupCount });
    }

    /**
     * 提供给 HTML 按钮反射调用的触碰事件处理
     */
    public static function doTouch(myHandIdx:Int, targetHandIdx:Int) {
        if (turnManager.gameOver) return;

        var actorIdx = turnManager.currentPlayerIdx;
        var targetIdx = (actorIdx == 0) ? 1 : 0;

        var actor = turnManager.players[actorIdx];
        var target = turnManager.players[targetIdx];

        // 执行 GameEngine 碰撞计算，引爆组合技
        var result = engine.handleTouch(actor, myHandIdx, target, targetHandIdx);
        
        if (result.indexOf("错误") == 0) {
            Browser.window.alert(result); // 👈 【核心修正】必须使用 Browser.window.alert
        } else {
            // 每次指尖变动后，立刻重新全场清算一次输赢
            turnManager.checkGameOver();
            render();
        }
    }

    /**
     * 将 Haxe 内存里的动态数据实时同步刷新到前端 DOM 树上
     */
    public static function render() {
        var players = turnManager.players;
        if (players.length < 2) return;

        Browser.document.getElementById("turnIndicator").innerText = '第 ${turnManager.turnCount} 回合';

        for (i in 0...2) {
            var p = players[i];
            
            Browser.document.getElementById('name${i}').innerText = p.name;
            Browser.document.getElementById('camp${i}').innerText = Std.string(p.camp);
            Browser.document.getElementById('hp${i}').innerText = Std.string(p.hp <= 0 ? 0 : p.hp);
            
            Browser.document.getElementById('h${i}_0').innerText = Std.string(p.hands[0]);
            Browser.document.getElementById('h${i}_1').innerText = Std.string(p.hands[1]);

            // 寿命变 0 的警告高亮
            toggleDeadClock('h${i}_0_box', 'dt${i}_0', p.hands[0] == 0, p.zeroTurns0);
            toggleDeadClock('h${i}_1_box', 'dt${i}_1', p.hands[1] == 0, p.zeroTurns1);

            // 刷新高亮行动框
            var card = Browser.document.getElementById('card${i}');
            if (card != null) {
                if (turnManager.currentPlayerIdx == i && !turnManager.gameOver) {
                    card.className = "player-card active";
                } else {
                    card.className = "player-card";
                }
            }

            // 刷新身上的 Buff 简易列表
            var buffText = "";
            for (b in p.buffList) {
                buffText += '[${b.name} x${b.layers}] ';
            }
            Browser.document.getElementById('buffs${i}').innerText = (buffText == "") ? "无" : buffText;

            // 【新增】刷新身上的护盾列表（如果有id为shields的元素）
            var shieldsElement = Browser.document.getElementById('shields${i}');
            if (shieldsElement != null) {
                var shieldText = "";
                for (s in p.shieldList) {
                    var typeName = switch (s.type) {
                        case PHYSICAL: "物理护盾";
                        case MAGIC: "法术护盾";
                        case BOTH_PHYSICAL_MAGIC: "物法护盾";
                        case TRUE: "真实护盾";
                    };
                    shieldText += '[${typeName} ${s.amount}/${s.duration}回合] ';
                }
                shieldsElement.innerText = (shieldText == "") ? "无" : shieldText;
            }

            // 【通用】角色自定义显示区（藏师蛋糕、孙悟空 x/y 等）
            var customDisplay = Browser.document.getElementById('custom${i}');
            if (customDisplay != null) {
                var displayHtml = p.getCustomDisplay();
                if (displayHtml == "") {
                    customDisplay.style.display = "none";
                } else {
                    customDisplay.style.display = "block";
                    customDisplay.innerHTML = displayHtml;
                }
            }

            // 【通用】角色自定义按钮区（藏师"使用蛋糕"等）
            var customActions = Browser.document.getElementById('actions${i}');
            if (customActions != null) {
                customActions.innerHTML = ""; // 清空
                var isMyTurn = (i == turnManager.currentPlayerIdx);
                if (isMyTurn && !turnManager.gameOver) {
                    var actions = p.getCustomActions();
                    for (a in actions) {
                        if (!a.enabled) continue;
                        var btn = Browser.document.createElement("button");
                        btn.textContent = a.label;
                        btn.style.cssText = 'margin:4px 4px 0 0;background:${a.color};color:white;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';
                        // 把 onClickJS 里的 __IDX__ 替换为实际索引
                        var jsCode = StringTools.replace(a.onClickJS, "__IDX__", Std.string(i));
                        btn.setAttribute("data-action", jsCode);
                        btn.onclick = function(e) {
                            var code = (cast e.currentTarget).getAttribute("data-action");
                            js.Syntax.code("eval({0})", code);
                        };
                        customActions.appendChild(btn);
                    }
                }
            }
        }

        // 终局判胜锁定
        if (turnManager.gameOver) {
            Browser.document.getElementById("actionPanel").style.display = "none";
            var winMsg = (turnManager.winningCamp != null) ? '🏆 最终胜出阵营：${turnManager.winningCamp}' : '💀 全场同归于尽，平局！';
            trace('=========================================');
            trace(winMsg);
            trace('=========================================');
        }
    }

    private static function toggleDeadClock(boxId:String, textId:String, isZero:Bool, turns:Int) {
        var box = Browser.document.getElementById(boxId);
        var txt = Browser.document.getElementById(textId);
        if (box != null && txt != null) {
            if (isZero && turns > 0) {
                box.className = "hand-box death-clock";
                txt.innerText = '0使用剩余次数: ${turns}步';
            } else {
                box.className = "hand-box";
                txt.innerText = "";
            }
        }
    }
}