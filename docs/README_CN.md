# ralph-flow 文档

[English](README.md) · [中文](README_CN.md)

欢迎阅读 ralph-flow 文档。本指南帮助你充分利用 opencode 的工作流自动化功能。

## 快速开始

第一次使用 ralph-flow？从这里开始：

1. [安装方式](../README_CN.md#-安装) — 安装插件
2. [快速开始](../README_CN.md#-快速开始) — 运行你的第一个工作流
3. [内置工作流](../README_CN.md#内置工作流) — `loop`、`spec`、`c-to-rust`、`everything2rust`

## 指南

常见任务的分步指南：

| 指南 | 说明 |
|------|------|
| [自定义工作流](custom-workflows_CN.md) | 用 YAML 创建自己的工作流 |
| [产出目录与模板](custom-workflows_CN.md#产出目录与模板变量) | 交付物放哪、唯一的模板记号 |
| [工作流嵌套](custom-workflows_CN.md#工作流嵌套) | 组合可复用的工作流组件 |
| [验证配置](custom-workflows_CN.md#adversarial_check) | 配置独立验证会话 |

## 参考

技术参考文档：

| 参考 | 说明 |
|------|------|
| [工作原理](how-it-works_CN.md) | 架构、会话事件、状态、多实例模型 |
| [命令参考](commands_CN.md) | 所有 slash 命令、工具和日志事件 |
| [文件结构](how-it-works_CN.md#文件结构) | 文件存放位置 |
| [SYNC.md](../SYNC.md) | 与 Claude Code 姊妹插件的结构映射 |

## 阅读顺序

**初学者：**
1. README（功能、安装、快速开始）
2. 自定义工作流（创建第一个工作流，然后跑 `/ralphflow-doctor`）
3. 命令参考（了解所有可用命令）

**进阶用户：**
1. 自定义工作流 → 工作流嵌套（组合复杂流水线）
2. 自定义工作流 → adversarial_check（优化验证）
3. 工作原理（了解内部机制和多实例模型）
