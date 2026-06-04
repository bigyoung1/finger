package model;

enum ShieldType {
    PHYSICAL;              // 仅抵挡物理伤害
    MAGIC;                 // 仅抵挡法术伤害
    BOTH_PHYSICAL_MAGIC;   // 抵挡物理和法术伤害（物法盾）
    TRUE;                  // 抵挡真实伤害
}