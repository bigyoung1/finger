package character;

import model.Player;
import model.Camp;

/**
 * 角色注册中心 —— 所有英雄的"工厂 + 元数据"集中在此
 * 新增角色只需在 init() 里 register 一行
 */
typedef CharacterEntry = {
    var id:String;          // 唯一ID，前端 select.value 用
    var displayName:String; // 下拉选项里显示的名字（含emoji和HP）
    var hp:Int;             // 标准HP
    var factory:String->Camp->Player; // 工厂方法
}

class CharacterRegistry {

    static var entries:Array<CharacterEntry> = [];
    static var inited:Bool = false;

    public static function init() {
        if (inited) return;
        inited = true;

        register("xiaoqiao",  "🌸 小乔 (半肉 360HP)", 360,
            (id, camp) -> new XiaoQiao(id, "小乔", camp));

        register("zangshi",   "🛡️ 藏师 (坦克 660HP)", 660,
            (id, camp) -> new ZangShi(id, "藏师", camp));

        register("fashi",     "⚡ 法师 (攻击 160HP)", 160,
            (id, camp) -> new FaShi(id, "法师", camp));

        register("sunwukong", "🐒 孙悟空 (半肉 260HP)", 260,
            (id, camp) -> new SunWuKong(id, "孙悟空", camp));

        register("daqiao",    "🌸 大乔 (半肉 120HP)", 120,
            (id, camp) -> new DaQiao(id, "大乔", camp));

        register("renzhe",    "🥷 忍者 (半肉 300HP)", 300,
            (id, camp) -> new RenZhe(id, "忍者", camp));

        register("zhangfei",  "🐗 张飞 (坦克 560HP)", 560,
            (id, camp) -> new ZhangFei(id, "张飞", camp));

        register("yinyangshi", "☯️ 阴阳师 (半肉 240HP)", 240,
            (id, camp) -> new YinYangShi(id, "阴阳师", camp));

        register("yangdali",  "💪 杨大力 (沙包 1000HP)", 1000,
            (id, camp) -> new Player(id, "杨大力", 1000, camp));

        // ── 白板（用工厂创建，名字写死） ──
        register("p1", "白板 A (刘备 350HP)", 350, (id, camp) -> new Player(id, "白板刘备", 350, camp));
        register("p2", "白板 B (曹操 350HP)", 350, (id, camp) -> new Player(id, "白板曹操", 350, camp));
        register("p3", "白板 C (赵云 350HP)", 350, (id, camp) -> new Player(id, "白板赵云", 350, camp));
        register("p4", "白板 D (吕布 350HP)", 350, (id, camp) -> new Player(id, "白板吕布", 350, camp));

        // 后续新角色只在这里 register 一行
    }

    static function register(id:String, displayName:String, hp:Int, factory:String->Camp->Player) {
        entries.push({id: id, displayName: displayName, hp: hp, factory: factory});
    }

    public static function createCharacter(id:String, camp:Camp):Player {
        init();
        for (e in entries) {
            if (e.id == id) return e.factory(id, camp);
        }
        return new Player(id, "未知角色", 350, camp);
    }

    /**
     * 给前端select用：返回所有角色 [{id, displayName}]
     */
    public static function getAllOptions():Array<{id:String, displayName:String}> {
        init();
        return [for (e in entries) {id: e.id, displayName: e.displayName}];
    }
}
