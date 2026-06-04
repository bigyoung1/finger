package buffs;
import model.Buff;
import model.Player;
import model.DamageType;

class DamageBoostBuff extends Buff {
    public function new(layers:Int = 2) {
        super("DMG_BOOST", "伤害翻倍", layers);
    }

    override public function onDealDamage(owner:Player, target:Player, amount:Int, type:DamageType):Int {
        // 只翻倍物理和真实伤害
        if (this.layers > 0 && (type == PHYSICAL || type == TRUE)) {
            this.layers--;
            trace('${owner.name} 触发伤害翻倍！');
            return amount * 2;
        }
        return amount;
    }
}