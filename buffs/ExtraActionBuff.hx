package buffs;
import model.Buff;

class ExtraActionBuff extends Buff {
    public function new(layers:Int = 1) {
        // 双八每次触发给 1 层再动（每大回合最多触发2次=2层）
        super("EXTRA_ACTION", "连击", layers); 
    }
    // 这个 Buff 不需要重写生命周期方法。
    // TurnManager 在切换玩家时，检查 current.getBuff("EXTRA_ACTION")
    // 如果有且 layers > 0，就 layers--，然后直接 return 不切换玩家！
}