import type { Tool, ToolResult } from "../types.ts";

type StepStatus = "pending" | "in_progress" | "done";

interface Step {
  step: string;
  status: StepStatus;
}

function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) throw new Error("steps must be an array");
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`steps[${index}] must be an object`);
    const record = raw as { step?: unknown; title?: unknown; status?: unknown };
    const title = typeof record.step === "string" ? record.step : typeof record.title === "string" ? record.title : "";
    if (title.length === 0) throw new Error(`steps[${index}] needs a "step" string`);
    const status = record.status === "done" || record.status === "in_progress" ? record.status : "pending";
    return { step: title, status };
  });
}

export const updatePlanTool: Tool = {
  name: "update_plan",
  description:
    "Publish or update a short task plan for the current request. Call it once at the start of multi-step work and again when steps complete. Keep it to 3-7 steps.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered list of steps.",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["step", "status"],
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  async run(args): Promise<ToolResult> {
    const steps = parseSteps(args["steps"]);
    const lines = steps.map((step) => {
      const box = step.status === "done" ? "[x]" : step.status === "in_progress" ? "[~]" : "[ ]";
      return `${box} ${step.step}`;
    });
    const done = steps.filter((step) => step.status === "done").length;
    return { ok: true, output: `Plan (${done}/${steps.length} done)\n${lines.join("\n")}` };
  },
};
