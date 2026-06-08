package buffs;
import model.Buff;
import model.Player;
import model.DamageType;

class PoisonBuff extends Buff {
    public function new(layers:Int = 1) {
        super("POISON", "中毒", layers);
    }

    override public function onTurnEnd(owner:Player) {
        if (this.layers > 0) {
            // 每层毒10点 MAGIC 伤害
            var damage = this.layers * 10;
            // 检查乌鸦buff：毒发整体+10（不管几层，因为毒不像法伤有翻倍词条）
            var crowExtra = 0;
            for (b in owner.buffList) {
                if (Std.isOfType(b, CrowBuff)) {
                    crowExtra = 10; // 固定+10
                    break;
                }
            }
            var finalDamage = damage + crowExtra;
            var result = owner.handleIncomingDamage(null, finalDamage, MAGIC);
            trace('${owner.name} 毒发！理论${finalDamage}（${damage}+乌鸦${crowExtra}） → 实际扣 ${result.actualDamage}！');

            // 乌鸦回调（毒伤无攻击者乘算，crowHeal = crowExtra）
            if (crowExtra > 0 && GameEngine.instance != null) {
                for (b in owner.buffList) {
                    if (Std.isOfType(b, CrowBuff)) {
                        cast(b, CrowBuff).onTriggered(crowExtra, GameEngine.instance);
                        break;
                    }
                }
            }

            // 通知全场：发生了一次毒伤扣血（让忍者按实际扣血量回血）
            if (result.actualDamage > 0 && GameEngine.instance != null) {
                GameEngine.instance.notifyPoisonTick(owner, result.actualDamage);
            }
        }
    }
}
