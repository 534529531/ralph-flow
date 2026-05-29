# 自定义工作流

在 `.opencode/ralph-flow/workflows/` 目录下创建 `.yaml` 文件即可定义自己的工作流。

---

## 快速示例

```yaml
steps:
  - id: analyze
    desc: 需求分析
    do: 分析用户需求并输出设计文档
    input: 用户需求描述
    output: design.md
    check: 验证设计文档是否完整、技术方案是否合理
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: 代码开发
    do: 根据设计文档实现代码
    input: design.md
    output: 可工作的代码
    check: 运行测试并验证实现
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

---

## 步骤字段参考

### 普通步骤

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识 |
| `desc` | ✅ | 步骤描述 |
| `do` | ✅ | 任务执行提示词 |
| `input` | ✅ | 预期输入说明 |
| `output` | ✅ | 预期输出说明 |
| `check` | ✅ | 验证标准 |
| `on_pass` | ✅ | 通过后的下一步（步骤 id 或 `"done"` 表示完成） |
| `on_fail` | ✅ | 失败后的下一步（步骤 id） |
| `max_fail_count` | ✅ | 最大失败次数（每个步骤独立） |

### 子工作流步骤

不使用 `do`/`check`/`input`/`output`，而是调用另一个工作流：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识 |
| `desc` | ✅ | 步骤描述 |
| `workflow` | ✅ | 要调用的工作流名称 |
| `inputs` | ❌ | 传递给子工作流的键值对参数 |
| `on_pass` | ✅ | 通过后的下一步 |
| `on_fail` | ✅ | 失败后的下一步 |
| `max_fail_count` | ✅ | 最大失败次数 |

详见[工作流嵌套](#工作流嵌套)。

---

## 工作流级选项

### `manual_step`

指定需要人工确认的步骤：

```yaml
manual_step: analyze, execute

steps:
  - id: analyze
    # ...
  - id: execute
    # ...
```

列入该列表的步骤，AI 完成工作后**不会自动继续** —— 需要你手动执行 `/ralphflow-continue`。

### `adversarial_check`

配置独立验证会话。默认情况下，CHECK 阶段使用 `ralph-check` agent。你可以自定义：

```yaml
adversarial_check:
  agent: "build"                    # 使用其他 agent
  model:                            # 指定验证使用的模型
    providerID: "anthropic"
    modelID: "claude-haiku-4-5"
  system_prompt: |                  # 自定义检查的系统提示词
    你是一个严格的代码审查员。
    检查以下内容：
    - 所有函数都有错误处理
    - 没有硬编码的密钥
    - 测试覆盖边界情况
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `agent` | 使用哪个 agent 进行验证 | `ralph-check` |
| `model` | 验证使用的模型（providerID + modelID） | 与主会话相同 |
| `system_prompt` | 自定义检查的系统提示词 | 内置验证提示词 |

**使用场景：**
- 使用**更便宜的模型**进行验证（如用 Haiku 检查 Sonnet 的工作）
- 使用**更严格的 agent**，只读不写
- 自定义**系统提示词**以适应特定领域的验证标准

---

## 工作流嵌套

步骤可以调用其他工作流，实现组合和复用。

### 基本用法

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: 需求分析
    workflow: analyze           # 调用 workflows/analyze.yaml
    inputs:
      task: "分析需求"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3

  - id: build
    desc: 代码实现
    workflow: build             # 调用 workflows/build.yaml
    on_pass: done
    on_fail: build
    max_fail_count: 3
```

### 传递参数

使用 `inputs` 向子工作流传递参数：

```yaml
steps:
  - id: analyze
    desc: 分析功能需求
    workflow: analyze
    inputs:
      task: "设计认证模块"
      context: "我们使用 JWT 和 refresh token"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3
```

参数会被包含在子工作流的 `user_task` 中，AI 可以访问它们。

### 多级嵌套

工作流最多支持 **5 层嵌套**：

```
full-dev.yaml
  └── analyze.yaml
       └── research.yaml
            └── ...
```

插件通过状态栈管理来保存父工作流的上下文。

### 工作原理

1. 父工作流到达子工作流步骤
2. 父状态被压入栈
3. 子工作流以合并的上下文（参数 + 原始任务）开始
4. 子工作流完成后，恢复父状态
5. 父工作流根据子工作流结果（通过/失败）继续

### 示例：模块化开发流水线

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: 需求分析
    workflow: analyze
    inputs:
      task: "分析和设计"
    on_pass: implement
    on_fail: analyze
    max_fail_count: 3

  - id: implement
    desc: 代码实现
    workflow: implement
    on_pass: test
    on_fail: implement
    max_fail_count: 5

  - id: test
    desc: 测试
    workflow: test
    on_pass: done
    on_fail: test
    max_fail_count: 3
```

每个子工作流（`analyze.yaml`、`implement.yaml`、`test.yaml`）可以有自己的步骤、验证和重试逻辑。

---

## 完成标记

AI 通过 XML 风格的标记来标识完成状态：

| 阶段 | 标记 | 说明 |
|------|------|------|
| DO 执行阶段 | `<promise>done</promise>` | 任务完成 |
| CHECK 检查阶段 | `<promise-check>true</promise-check>` | 验证通过 |
| CHECK 检查阶段 | `<promise-check>false</promise-check>` | 验证未通过 |

> 标记**不区分大小写**，允许空格。`<promise>DONE</promise>` 同样有效。

---

## 多步骤流转设计

### 线性流转

最简单的模式 —— 步骤按顺序执行：

```yaml
steps:
  - id: design
    desc: 设计阶段
    do: 创建技术设计文档
    check: 验证设计完整性
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现阶段
    do: 根据设计编写代码
    check: 运行测试
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 分支流转

步骤可以根据检查结果跳转到不同步骤：

```yaml
steps:
  - id: analyze
    desc: 分析问题
    do: 判断是 bug 修复还是新功能
    check: 分析是否正确？
    on_pass: implement
    on_fail: clarify
    max_fail_count: 2

  - id: clarify
    desc: 请求澄清
    do: 向用户询问更多细节
    check: 用户是否提供了足够信息？
    on_pass: analyze
    on_fail: clarify
    max_fail_count: 3

  - id: implement
    desc: 实现修复
    do: 编写代码
    check: 是否正常工作？
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 恢复流转

使用 `on_fail` 路由到专门的恢复步骤：

```yaml
steps:
  - id: build
    desc: 构建项目
    do: 执行构建流程
    check: 构建是否成功？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 2

  - id: fix-build
    desc: 修复构建错误
    do: 读取错误输出并修复问题
    check: 构建是否通过？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 5

  - id: test
    desc: 运行测试
    do: 执行测试套件
    check: 所有测试是否通过？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 3

  - id: fix-tests
    desc: 修复失败的测试
    do: 分析测试失败原因并修复
    check: 测试是否通过？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 5
```

### 循环流转（回退）

使用 `on_fail` 回退到前面的步骤，形成循环：

```yaml
steps:
  - id: design
    desc: 设计
    do: 创建技术设计
    check: 设计是否完整合理？
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现
    do: 根据设计编写代码
    check: 代码能否通过编译和 lint？
    on_pass: test
    on_fail: design          # 实现发现问题时回退到设计
    max_fail_count: 3

  - id: test
    desc: 测试
    do: 运行完整测试套件
    check: 所有测试是否通过？
    on_pass: done
    on_fail: implement       # 测试失败时回退到实现
    max_fail_count: 5
```

形成循环：`design → implement → test → implement → test → ...`

如果实现发现设计有问题，回退到 `design`；如果测试失败，回退到 `implement`。工作流自然收敛到可工作的解决方案。

### 完整流水线（多循环）

```yaml
steps:
  - id: analyze
    desc: 需求分析
    do: 分析需求并创建规格说明
    check: 规格是否完整？
    on_pass: design
    on_fail: analyze
    max_fail_count: 3

  - id: design
    desc: 技术设计
    do: 创建架构和设计文档
    check: 设计是否合理？
    on_pass: implement
    on_fail: analyze         # 设计需要重新思考时回退到分析
    max_fail_count: 3

  - id: implement
    desc: 代码实现
    do: 编写代码
    check: 能否编译通过？
    on_pass: test
    on_fail: design          # 实现遇到阻碍时回退到设计
    max_fail_count: 3

  - id: test
    desc: 测试
    do: 运行测试
    check: 所有测试是否通过？
    on_pass: done
    on_fail: implement       # 测试失败时回退到实现
    max_fail_count: 5
```

多个循环：`analyze ↔ design → implement ↔ test`

---

## 使用建议

- **保持步骤聚焦** — 每个步骤只做一件事
- **使用描述性的 `desc`** — 会显示在状态输出中
- **设置合理的 `max_fail_count`** — 太低会频繁暂停，太高浪费 token
- **编写清晰的 `check` 提示词** — 验证质量取决于你对"完成"的描述
- **谨慎使用 `manual_step`** — 自动继续是工作流的核心优势
- **使用子工作流复用** — 常见模式（分析、构建、测试）可以跨工作流共享
- **用更便宜的模型验证** — `adversarial_check.model` 可以节省成本
