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
            // 每层毒10点 MAGIC 伤害（法盾/法免/法术减伤可抵挡）
            var damage = this.layers * 10;
            // 走 handleIncomingDamage 走护盾/减伤
            // 注意：attacker = null（毒伤无来源）
            var result = owner.handleIncomingDamage(null, damage, MAGIC);
            trace('${owner.name} 毒发！理论${damage} → 实际扣 ${result.actualDamage}！');

            // 通知全场：发生了一次毒伤扣血（用 actualDamage，让忍者按实际扣血量回血）
            if (result.actualDamage > 0 && GameEngine.instance != null) {
                GameEngine.instance.notifyPoisonTick(owner, result.actualDamage);
            }
            // 不减层数：除非被 RECOVERY 类型治疗解毒
        }
    }
}
