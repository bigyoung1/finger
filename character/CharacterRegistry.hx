package character;

import model.Player;
import model.Camp;

/**
 * 角色注册中心。
 *
 * 角色列表由 CharacterRegistryMacro 在编译期扫描 character/*.hx 自动生成。
 * 新角色只需：
 *   1. 在角色类上添加 @:gameCharacter("id", "中文名", "定位", "emoji")；
 *   2. 在 image/ 下添加同名的「中文名.png」；
 *   3. 运行 haxe build.hxml。
 *
 * 不再手工维护注册列表或前端头像映射。
 */
typedef CharacterEntry = {
    var id:String;
    var name:String;
    var role:String;
    var emoji:String;
    var displayName:String;
    var hp:Int;
    var trainable:Bool;
    var factory:String->Camp->Player;
}

class CharacterRegistry {
    static var entries:Array<CharacterEntry> = CharacterRegistryMacro.buildEntries();

    public static function init():Void {}

    public static function createCharacter(id:String, camp:Camp):Player {
        for (entry in entries) {
            if (entry.id == id) return entry.factory(id, camp);
        }
        return new Player(id, "未知角色", 350, camp);
    }

    /** 供前端和 AI 使用的统一角色目录。 */
    public static function getAllOptions():Array<Dynamic> {
        return [for (entry in entries) {
            id: entry.id,
            name: entry.name,
            role: entry.role,
            emoji: entry.emoji,
            displayName: entry.displayName,
            hp: entry.hp,
            trainable: entry.trainable,
            image: 'image/${entry.name}.png'
        }];
    }
}
