package character;

import model.Player;
import model.Camp;
import model.DamageType;
import model.HealType;
import model.ShieldType;

/**
 * 藏师（坦克 | HP 330）
 * (1) 受到的所有物理伤害减半（法术/真伤不减）
 * (2) 受到物理伤害减半结算后，反弹自身实际扣血量 50% 的物理伤害（与双5共用反弹机制）
 * (3) 自身回复量×2.5；自身获得护盾厚度×2
 * (4) 草莓蛋糕：场上每发生一次回血/获盾（每大回合上限8次），藏师获得 1 个蛋糕
 *     每 3 个蛋糕可对任一目标造成 10 点法伤 + 自身补给 10 血
 *     技能内产生的回血/获盾不计入（如毒伤反向、藏师自己补给）
 *     蛋糕无上限，藏师可在任意自己回合释放
 */
class ZangShi extends Player {


    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 3000, camp);
    }}