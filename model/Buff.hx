package model;

class Buff {
    public var id:String;
    public var name:String;
    public var layers:Int; // 层数（如双4下两次发效，层数为2；毒伤叠加，层数为n）

    public function new(id:String, name:String, layers:Int = 1) {
        this.id = id;
        this.name = name;
        this.layers = layers;
    }

    // 钩子1：回合开始
    public function onTurnStart(owner:Player) {}
    
    // 钩子2：回合结束（毒伤在这里结算）
    public function onTurnEnd(owner:Player) {}
    public function onBigRoundEnd(owner:Player) {}
    
    // 钩子3：造成伤害前（双4的伤害翻倍在这里）
    public function onDealDamage(owner:Player, target:Player, amount:Int, type:DamageType):Int {
        return amount;
    }
    
    // 钩子4：承受伤害前（双5的反弹无伤在这里）
    public function onTakeDamage(owner:Player, attacker:Player, amount:Int, type:DamageType):Int {
        return amount;
    }
}