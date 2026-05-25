export interface RalphCommandDef {
  description: string;
  template: string;
}

export const RALPH_COMMANDS: Record<string, RalphCommandDef> = {
  "ralphflow-start": {
    description: "Start a workflow",
    template: `启动工作流执行。

如果用户已经在消息中明确指定了工作流名称和任务描述，直接调用 ralphflow-start 工具，不要再重复询问。
如果用户只提供了部分信息（例如只说了任务但没选工作流，或只说了工作流名但没描述任务），调用 tool 时传入已有参数，缺失的部分 tool 会自动提示补充。
如果用户完全没有指定任何信息，则先询问用户选择哪个工作流以及执行什么任务。

工作流名称可用 ralphflow-list 查看。`,
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
