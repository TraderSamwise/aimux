import type { InteractionPayload, InteractionType } from "../interaction-requests.js";

export type InteractionDisplay = {
  title: string;
  message: string;
  summary?: string;
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseObjectString(value: unknown): Record<string, unknown> | undefined {
  const text = trimmedString(value);
  if (!text || !text.startsWith("{")) return undefined;
  try {
    return objectRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function questionRecordsFromSource(source: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const questions = Array.isArray(source?.questions) ? source.questions : undefined;
  if (questions)
    return questions.map(objectRecord).filter((question): question is Record<string, unknown> => Boolean(question));
  const question = objectRecord(source);
  return question ? [question] : [];
}

function questionRecords(payload: InteractionPayload, summary?: string): Record<string, unknown>[] {
  const payloadQuestions = questionRecordsFromSource(objectRecord(payload)).filter((question) =>
    trimmedString(question.question),
  );
  if (payloadQuestions.length > 0) return payloadQuestions;
  return questionRecordsFromSource(parseObjectString(summary)).filter((question) => trimmedString(question.question));
}

function questionOptionLabels(question: Record<string, unknown>): string[] {
  const options = Array.isArray(question.options) ? question.options : [];
  return options
    .map((option) => {
      if (typeof option === "string") return option.trim();
      return trimmedString(objectRecord(option)?.label);
    })
    .filter((label): label is string => Boolean(label));
}

function formatQuestionText(question: Record<string, unknown>, index: number, total: number): string {
  const prompt = trimmedString(question.question) ?? "";
  const prefix = total > 1 ? `${index + 1}. ` : "";
  const labels = questionOptionLabels(question);
  return labels.length > 0 ? `${prefix}${prompt}\nOptions: ${labels.join("; ")}` : `${prefix}${prompt}`;
}

export function summarizeInteractionForDisplay(input: {
  sessionId: string;
  type: InteractionType;
  payload: InteractionPayload;
  summary?: string;
}): InteractionDisplay {
  if (input.type === "question") {
    const questions = questionRecords(input.payload, input.summary);
    if (questions.length > 0) {
      const prompts = questions
        .map((question) => trimmedString(question.question))
        .filter((prompt): prompt is string => Boolean(prompt));
      return {
        title: "AskUserQuestion",
        message: questions.map((question, index) => formatQuestionText(question, index, questions.length)).join("\n\n"),
        summary: prompts.join("; "),
      };
    }
  }

  const summary = trimmedString(input.summary);
  const readableSummary = parseObjectString(summary) ? undefined : summary;
  return {
    title: `${input.sessionId} needs a response`,
    message: readableSummary ?? `Agent is waiting on a ${input.type} response.`,
    summary: readableSummary,
  };
}
