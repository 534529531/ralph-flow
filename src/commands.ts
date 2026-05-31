export interface RalphCommandDef {
  description: string;
  template: string;
}

export const RALPH_COMMANDS: Record<string, RalphCommandDef> = {
  "ralphflow-start": {
    description: "Start a workflow",
    template: `启动工作流执行。

用户需要同时指定工作流名称和任务描述才能开始。如果信息不全，先询问用户补充：

- 只说了任务没选工作流 → 问用户想用哪个工作流

- 只说了工作流没说任务 → 问用户要做什么
- 都没说 → 依次询问

不要根据用户输入推断应该使用哪个工作流，让用户自己选择。

信息齐全后，调用 ralphflow-start 工具启动。
可用工作流：调用 ralphflow-list 查看。

## 工作流机制

工作流每个步骤包含两个阶段：

**do 阶段**（执行）：
- 执行当前步骤描述的任务
- 完成后输出 \`<promise>done</promise>\` 标记
- 系统自动进入 check 阶段

**check 阶段**（检查）：
- 检查任务是否按要求完成
- 通过：输出 \`<promise-check>true</promise-check>\`，进入下一步骤
- 不通过：输出 \`<promise-check>false</promise-check>\` 并说明原因，重新执行 do 阶段

**重要**：你必须在完成任务后输出对应标记，否则系统无法推进工作流。`,
  },
  "ralphflow-continue": {
    description: "Continue a paused workflow",
    template: `继续已暂停的工作流。

工作流因达到最大失败次数而暂停。
重置失败计数器并从当前步骤继续执行。

调用 ralphflow-continue 工具恢复工作流。`,
  },
  "ralphflow-cancel": {
    description: "Cancel the current workflow",
    template: `取消当前工作流。

调用 ralphflow-cancel 工具取消工作流。`,
  },
  "ralphflow-status": {
    description: "Show workflow status",
    template: `显示当前工作流状态。

调用 ralphflow-status 工具显示状态信息。`,
  },
  "ralphflow-list": {
    description: "List available workflows",
    template: `列出所有可用的工作流。

调用 ralphflow-list 工具显示工作流列表。`,
  },
};
