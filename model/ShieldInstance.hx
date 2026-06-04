package model;

class ShieldInstance {
    public var type:ShieldType;
    public var amount:Int;
    public var duration:Int;

    public function new(type:ShieldType, amount:Int, duration:Int) {
        this.type = type;
        this.amount = amount;
        this.duration = duration;
    }
}