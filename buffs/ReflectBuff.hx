package buffs;
import model.Buff;
import model.Player;
import model.DamageType;

/**
 * 反弹盾：受到物理伤害时反弹一半给攻击者，自身免疫本次伤害
 * 
 * 之前用静态变量 _reflecting 防止A↔B无限互弹，但静态变量在多角色场景有隐患。
 * 改为：反弹造成的伤害通过 applyRawDamage（不触发 onAfterDealtDamage），
 * 而反弹伤害本身也是"物理伤害"，会再次进入目标的 onTakeDamage，
 * 因此用 GameEngine 级别的一次性守卫（临时标记在 engine 上）来防止双向反弹。
 * 
 * 实现：在 engine 上放一个 isReflecting:Bool 标记（见 GameEngine.hx）。
 */
class ReflectBuff extends Buff {

    public function new(layers:Int = 2) {
        super("REFLECT", "反伤盾", layers);
    }

    override public function onTakeDamage(owner:Player, attacker:Player, amount:Int, type:DamageType):Int {
        if (type != PHYSICAL) return amount;
        if (this.layers <= 0) return amount;

        // 从 GameEngine.instance 取守卫（不再用静态变量）
        var engine = GameEngine.instance;
        if (engine != null && engine.isReflecting) return amount; // 正在反弹中，不再次反弹

        this.layers--;
        var reflectDmg = Std.int(Math.min(amount / 2, 200)); // 反弹上限200

        if (attacker != null && reflectDmg > 0 && engine != null) {
            trace('${owner.name} 触发反伤！反弹 ${reflectDmg} 点物伤给 ${attacker.name}！');
            engine.isReflecting = true;
            var reflectResult = attacker.handleIncomingDamage(owner, reflectDmg, PHYSICAL);
            engine.isReflecting = false;
            // 登记帮抗事件：反弹可能致死，供 JS 层弹窗判定（之前漏掉这一步导致反弹直接秒人无法帮抗）
            if (reflectResult.actualDamage > 0) {
                engine.registerHelpTankEvent(attacker, owner, reflectResult.actualDamage, PHYSICAL, "反弹盾");
            }
        }

        return 0; // 自身免疫本次伤害
    }
}
