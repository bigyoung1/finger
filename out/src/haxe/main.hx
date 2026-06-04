package;

import model.Player;
import model.Camp;
import js.Browser;
import js.html.Element;

@:keep
@:expose //
class Main {
    // 实例化核心控制器
    public static var engine:GameEngine = new GameEngine();
    public static var turnManager:TurnManager = new TurnManager();

    public static function main() {
        // 绑定页面“开始游戏”按钮
        var startBtn = Browser.document.getElementById("startBtn");
        startBtn.onclick = function() {
            setupAndStart();
        };

        var endTurnBtn = Browser.document.getElementById("endTurnBtn");
        endTurnBtn.onclick = function() {
            turnManager.nextTurn();
            render();
        };

        // 重定向 Haxe 的 trace 系统的输出，让它直接打印在网页的黑色日志框里！
        haxe.Log.trace = function(v:Dynamic, ?infos:haxe.PosInfos) {
            var logPanel = Browser.document.getElementById("logPanel");
            var line = Browser.document.createElement("div");
            line.className = "log-line";
            
            var text:String = Std.string(v);
            if (text.indexOf("🎉") != -1 || text.indexOf("🏆") != -1 || text.indexOf("⚠️") != -1) {
                line.className = "log-line log-important";
            }
            line.innerText = text;
            logPanel.appendChild(line);
            logPanel.scrollTop = logPanel.scrollHeight; // 滚动条自动拉到底
        };
    }

    /**
     * 读取前端选择，激活对应的两个角色开启 1v1 测试
     */
    public static function setupAndStart() {
        var heroSelect:Dynamic = Browser.document.getElementById("heroSelect");
        var rebelSelect:Dynamic = Browser.document.getElementById("rebelSelect");

        var heroName = (heroSelect.value == "p1") ? "白板刘备" : "白板赵云";
        var rebelName = (rebelSelect.value == "p2") ? "白板曹操" : "白板吕布";

        // 1. 预设 4 个角色中激活选中的 2 个，血量均设为 350 
        var p1 = new Player(heroSelect.value, heroName, 350, Camp.HERO);
        var p2 = new Player(rebelSelect.value, rebelName, 350, Camp.REBEL);

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
     * 提供给 HTML 按钮反射调用的触碰事件处理
     */
    public static function doTouch(myHandIdx:Int, targetHandIdx:Int) {
        if (turnManager.gameOver) return;

        // 依靠 TurnManager 自动算出当前谁是主攻手，谁是挨打的目标
        var actorIdx = turnManager.currentPlayerIdx;
        var targetIdx = (actorIdx == 0) ? 1 : 0;

        var actor = turnManager.players[actorIdx];
        var target = turnManager.players[targetIdx];

        // 执行 GameEngine 碰撞计算，引爆组合技
        var result = engine.handleTouch(actor, myHandIdx, target, targetHandIdx);
        
        if (result.indexOf("错误") == 0) {
            Browser.alert(result);
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

        // 刷新轮数标题
        Browser.document.getElementById("turnIndicator").innerText = '第 ${turnManager.turnCount} 轮对决';

        for (i in 0...2) {
            var p = players[i];
            
            // 刷新基础数值
            Browser.document.getElementById('name${i}').innerText = p.name;
            Browser.document.getElementById('camp${i}').innerText = Std.string(p.camp);
            Browser.document.getElementById('hp${i}').innerText = Std.string(p.hp <= 0 ? 0 : p.hp);
            
            // 刷新双手
            Browser.document.getElementById('h${i}_0').innerText = Std.string(p.hands[0]);
            Browser.document.getElementById('h${i}_1').innerText = Std.string(p.hands[1]);

            // 寿命变 0 的警告高亮
            toggleDeadClock('h${i}_0_box', 'dt${i}_0', p.hands[0] == 0, p.zeroTurns0);
            toggleDeadClock('h${i}_1_box', 'dt${i}_1', p.hands[1] == 0, p.zeroTurns1);

            // 刷新高亮行动框
            var card = Browser.document.getElementById('card${i}');
            if (turnManager.currentPlayerIdx == i && !turnManager.gameOver) {
                card.className = "player-card active";
            } else {
                card.className = "player-card";
            }

            // 刷新身上的 Buff 简易列表
            var buffText = "";
            for (b in p.buffList) {
                buffText += '[${b.name} x${b.layers}] ';
            }
            Browser.document.getElementById('buffs${i}').innerText = (buffText == "") ? "无" : buffText;
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
        if (isZero && turns > 0) {
            box.className = "hand-box death-clock";
            txt.innerText = '0使用剩余次数: ${turns}步';
        } else {
            box.className = "hand-box";
            txt.innerText = "";
        }
    }
}