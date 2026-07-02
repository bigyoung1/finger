🌸 小乔
两个联动机制，互不套娃：

打人 → 补给自己：onAfterDealtDamage，用 applyRawHeal SUPPLY，量 = 实际扣血量（护盾挡完之后）。你那个例子是对的：打60，目标50物法盾挡了40，实际扣20 → 小乔补给20。
回血 → 打敌人：onAfterHeal，用 applyRawDamage，量 = 实际回血量（含小乔自己的×1.5倍率）。注意是 notifyOutputDamage 也一并调了，所以能更新孙悟空的x。

两者的倍率关系：

小乔物伤×1.5在 calculateOutputDamage 里，这个倍率作用于主动攻击，补给回血那段走 applyRawDamage 绕过了倍率，不再×1.5。
小乔回血×1.5在 calculateFinalHeal 里，例如[0,6]基础30血，经过×1.5回45血，然后对敌人造成45物伤（不再×1.5，因为是 applyRawDamage）。


🛡️ 藏师

蛋糕释放：对目标造成10×组数法伤，自己 applyRawHeal RECOVERY 10×组数血。是固定值，不走 calculateFinalHeal（没有×2.5）。
普通回血（[0,6]等）：走 calculateFinalHeal → ×2.5。RECOVERY类型，可被大乔抢。
无"打人补给"机制，蛋糕只算造了伤害（产蛋糕），自己的供给是单独的补给血。


⚡ 法师

雷霆回血：onAnyThunderTick，applyRawHeal SUPPLY，量 = 雷霆实际扣血量。绕过了 calculateFinalHeal，无倍率。
法师没有主动回血技能，唯一来源是雷霆的被动补给。不是"打多少回多少"，是"雷霆实际造成多少伤扣掉就补多少"。


🐒 孙悟空

[0,2]大招：applyHeal(this, 70, RECOVERY) — 走完整流程，会触发 calculateFinalHeal，孙悟空的 calculateFinalHeal 额外加y点。所以实际回血 = 70 + y，这个回血量会更新y（变成70+旧y），大乔能抢。
你举的例子分析：孙悟空对目标造成70法伤，目标有50物法盾 → 全挡（法伤被物法盾抵）→ 目标扣0。孙悟空自己回（70+y）血，大乔能抢这部分。


🌸 大乔

打人回血：onAfterDealtDamage，applyHeal(this, actualDamage*0.5, RECOVERY)。走完整流程，量 = 实际扣血量的50%（护盾挡完之后算）。普通大乔没有输出倍率，神大乔物伤×1.5，但回血基数还是 actualDamage 的50%。这个回血是RECOVERY，可以被场上另一个大乔抢（如果2v2都有大乔）。
抢到的血：applyRawHeal SUPPLY，不可再被抢，不更新孙悟空y。


🥷 忍者
三段独立回血，全部SUPPLY：

追加法伤 → 补给自己：物伤完成后追加50%法伤（基于含buff后的物伤值，不含目标减伤），applyRawDamage 法伤，result.actualDamage 是法伤实际扣血量（穿透护盾之后），按这个值 applyRawHeal SUPPLY 补给自己。
敌方中毒扣血 → 补给自己：onAnyPoisonTick，applyRawHeal SUPPLY，量 = 毒伤实际扣血量。
敌方解一层毒 → 补给20：onAnyPoisonCleared，固定20血 SUPPLY。


🐗 张飞

回合结束补给10血（狂暴20）：applyRawHeal SUPPLY，不走 calculateFinalHeal，固定值，绕过所有倍率。
模态③打人回血：applyRawHeal RECOVERY，量 = actualDamage / 2（实际扣血量的一半）。是RECOVERY，大乔能抢，可解毒。


总结对比表
角色触发条件回血基数类型走倍率？小乔·补给造成物伤实际扣血量SUPPLY❌ raw小乔·普通回血各种组合基础值×1.5RECOVERY✅藏师·蛋糕主动释放固定10×组数RECOVERY❌ raw藏师·普通回血各种组合基础值×2.5RECOVERY✅法师·雷霆雷霆扣血雷霆实际扣血量SUPPLY❌ raw孙悟空·[0,2]大招70+yRECOVERY✅（含y加成）大乔·打人造成物伤实际扣血量×50%RECOVERY✅大乔·抢夺所得抢夺netHeal×50%(+10神)SUPPLY❌ raw忍者·法伤联动附加法伤落地法伤实际扣血量SUPPLY❌ raw忍者·毒伤联动敌方中毒扣血毒伤实际扣血量SUPPLY❌ raw忍者·解毒联动敌方解毒固定20SUPPLY❌ raw张飞·回合结束行动结束固定10（狂暴20）SUPPLY❌ raw张飞·模态③造成物伤实际扣血量÷2RECOVERY❌ raw