package character;

import model.Player;
import model.Camp;

/**
 * 杨大力（沙包 | 1000HP）
 *
 * 定位：测试/新手用高血量基准角色。
 * - 无主动技能
 * - 无被动加成
 * - 完全使用 Player 默认规则、默认组合、默认护盾/伤害/回血结算
 *
 * 保留独立子类的原因：
 * 1. CharacterRegistry 可以统一通过角色类创建所有角色；
 * 2. 后续如果要给杨大力补技能，不需要再改注册中心结构；
 * 3. 避免旧文件误写成 ZangShi 导致类名与文件名不一致。
 */
@:gameCharacter("yangdali", "杨大力", "沙包", "💪", false)
class Yangdali extends Player {
    public function new(id:String, name:String, camp:Camp) {
        super(id, name, 1000, camp);
    }
}
