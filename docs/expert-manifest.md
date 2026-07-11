# RanParty 专家团队清单

专家团队清单放在 `Config/Experts/*.json`。当前支持 `schemaVersion: 1`；未知版本会被拒绝。团队不会扩大任何 Skill、MCP、文件、网络或命令权限。

```json
{
  "schemaVersion": 1,
  "kind": "team",
  "id": "product-review-team",
  "name": "产品评审团队",
  "description": "由负责人组织研究、交互和工程专家完成评审。",
  "leaderSkillId": "已安装负责人的-skill-id",
  "memberSkillIds": ["研究专家-skill-id", "交互专家-skill-id", "工程专家-skill-id"],
  "collaboration": "负责人先拆解任务，将独立工作交给对应成员并行完成。",
  "summaryRule": "核对成员结论，消除重复和冲突，标注风险并给出统一行动项。",
  "maxParallel": 3
}
```

WorkBuddy 风格包可先将 `expert/agents/*.md` 作为显式 Skill 安装，再用清单绑定负责人和成员。运行时由负责人调用现有隔离子 Agent；每个成员仍受当前会话授权策略约束。
