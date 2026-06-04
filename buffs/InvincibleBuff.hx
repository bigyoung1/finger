package buffs;
import model.Buff;
import model.Player;
import model.DamageType;

/**
 * 无敌Buff（[1,1] 大招）：
 * 免疫所有物理和法术伤害，但真实伤害仍可穿透。
 * layers 用作"剩余有效回合数"。
 */
class InvincibleBuff extends Buff {
    public function new(turns:Int = 2) {
        super("INVINCIBLE", "无敌", turns);
    }

    /**
     * 拦截伤害：物理/法术 → 完全免疫；真实伤害 → 穿透
     */
    override public function onTakeDamage(owner:Player, attacker:Player, amount:Int, type:DamageType):Int {
        if (this.layers > 0) {
            if (type == PHYSICAL || type == MAGIC) {
                trace('🛡️ ${owner.name} 处于无敌状态，免疫 ${amount} 点 ${type} 伤害！');
                return 0;
            }
            // TRUE 真实伤害穿透
        }
        return amount;
    }

    /**
     * 每次轮到自己回合结束时，减一回合
     */
    override public function onTurnEnd(owner:Player) {
        if (this.layers > 0) {
            this.layers--;
            if (this.layers <= 0) {
                trace('💨 ${owner.name} 的无敌效果消失了。');
            } else {
                trace('🛡️ ${owner.name} 的无敌效果剩余 ${this.layers} 回合。');
            }
        }
    }
}
