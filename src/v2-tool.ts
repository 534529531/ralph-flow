import { z } from "zod";
import type { ToolContext, Info as V2ToolInfo } from "@opencode/plugin/promise/tool";

type ToolShape = Record<string, z.ZodType>;

export interface LegacyToolDefinition<Shape extends ToolShape = ToolShape> {
  description: string;
  args: Shape;
  execute(input: z.infer<z.ZodObject<Shape>>, context: ToolContext): Promise<string> | string;
}

function defineLegacyTool<Shape extends ToolShape>(definition: LegacyToolDefinition<Shape>): LegacyToolDefinition<Shape> {
  return definition;
}

/**
 * 保留旧工具定义的窄接口，让状态机工具实现仍返回字符串；只在 V2 注册边界
 * 转成 Standard Schema 输入和结构化 Tool.Result。
 */
export const tool = Object.assign(defineLegacyTool, { schema: z });

export function toV2Tool(name: string, definition: LegacyToolDefinition): V2ToolInfo {
  const input = z.object(definition.args);
  const output = z.string();
  return {
    name,
    description: definition.description,
    input,
    output,
    async execute(value, context) {
      const text = await definition.execute(value as never, context);
      return { output: text, content: text };
    },
  };
}
