# ralph-flow 文档

## 快速上手

| 文档 | 说明 |
|------|------|
| [主页 README](../README.md) | 功能介绍、快速开始、安装 |
| [自定义工作流](custom-workflows.md) | YAML 字段参考、重置门、分支、嵌套 |
| [命令参考](commands.md) | 所有 slash 命令、工具参数、日志事件 |

## 指南

| 指南 | 5 分钟读 | 说明 |
|------|----------|------|
| [创建设计一个工作流](custom-workflows.md#快速示例) | ✅ | YAML 从零到一，附示例 |
| [产出目录与模板变量](custom-workflows.md#产出目录与模板变量) | ✅ | 交付物放哪、唯一模板记号 |
| [人工审查门](custom-workflows.md#manual_step) | ✅ | 在验证前停下来让你审查 |
| [上下文重置门（reset）](custom-workflows.md#上下文重置门reset) | | 步骤级 `reset`、工作流级 `auto_reset`、手动 `/ralphflow-reset` |
| [中途回退（rewind）](custom-workflows.md#中途回退rewind) | | 倒退到上游已通过步骤重做 |
| [子工作流与嵌套](custom-workflows.md#工作流嵌套) | | 组合可复用工作流组件，含输入传递 |
| [对抗性验证配置](custom-workflows.md#adversarial_check) | | 配置验证者的 agent、模型、超时 |

## 参考

| 文档 | 说明 |
|------|------|
| [工作原理](how-it-works.md) | 架构：DO/CHECK 循环、独立验证、多实例模型、会话事件、文件结构 |
| [命令参考](commands.md) | 命令表、使用示例、工具 API、日志事件、实例与报告格式 |
| [重置门与回退设计](reset-gate-design.md) | 技术方案：触发规则、abort 顺序、parentID 决策、会话交接简报 |
| [SYNC.md](../SYNC.md) | 与 Claude Code 姊妹插件的结构映射与镜像约束 |

## 进阶：场景速查

| 你在 | 需要 | 做法 |
|------|------|------|
| 流程跑到一半上下文太长了 | 换干净上下文继续当前步 | `/ralphflow-reset` |
| 后期发现早期某步方向走错 | 回到那步重做 | `/ralphflow-rewind <步> "原因"` |
| 某步完了停下来等你审查 | 通过 → 继续 | `/ralphflow-continue`；或直接跟 AI 说要改哪里 |
| 工作流卡死/暂停 | 恢复执行 | `/ralphflow-continue` |
| 彻底放弃 | 取消并留报告 | `/ralphflow-cancel` |
| 不确定工作流定义有没有坑 | 预检 | `/ralphflow-doctor` |
| 多个会话要跑不同任务 | 并行启动 | 各自开一个会话，各自 `/ralphflow-start` |
| 换个会话接管中断的实例 | 续命 | `/ralphflow-continue <实例前缀>` |
| 想设计一个新工作流 | 交互式创建 | `/ralphflow-create` |

---

## 阅读路线

**第一次用：**
1. [主页 README](../README.md) → 了解它是干什么的
2. [自定义工作流](custom-workflows.md) → 写一个最简单的两步骤，跑 `/ralphflow-doctor` 检查
3. [命令参考](commands.md) → 摸熟所有可用操作

**深入理解：**
1. [工作原理](how-it-works.md) → 消化 DO/CHECK 循环和独立验证的设计理由
2. [自定义工作流 → 工作流嵌套](custom-workflows.md#工作流嵌套) → 构建复合流水线
3. [对抗性验证配置](custom-workflows.md#adversarial_check) → 按项目调优验证
