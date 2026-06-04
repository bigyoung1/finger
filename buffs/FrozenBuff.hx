package buffs;

import model.Buff;
import model.Player;
import model.DamageType;

/**
 * 冰冻 Buff
 * 持有者下一次"轮到自己"时直接跳过行动（但zeroTurns/中毒/雷霆/护盾持续时间等正常结算）
 * 跳过后 layers--，归零自动清除
 */
class FrozenBuff extends Buff {
    public function new(turns:Int = 1) {
        super("FROZEN", "冰冻", turns);
    }
}
