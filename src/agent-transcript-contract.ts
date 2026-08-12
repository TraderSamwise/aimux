export type RichTextMark = "bold" | "dim" | "italic" | "underline" | "strike";

export interface RichTextColor {
  model: "rgb";
  value: string;
}

export interface RichTextSpan {
  text: string;
  marks?: RichTextMark[];
  foreground?: RichTextColor;
  background?: RichTextColor;
}

export interface AgentTranscriptImagePart {
  type: "image_reference";
  label: string;
  attachmentId: string;
  filename?: string;
  mimeType?: string;
}

export interface AgentTranscriptTextPart {
  type: "text";
  text: string;
  spans?: RichTextSpan[];
}

export type AgentTranscriptPart = AgentTranscriptTextPart | AgentTranscriptImagePart;

export interface AgentTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  parts: AgentTranscriptPart[];
  text: string;
  latest?: true;
}
