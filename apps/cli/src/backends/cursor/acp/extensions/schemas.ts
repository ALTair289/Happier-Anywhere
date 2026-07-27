import { z } from 'zod';

const opaqueId = z.string().min(1).max(512).refine((value) => value.trim().length > 0, {
  message: 'Identifier must not be blank',
});
const id = opaqueId;
const shortText = z.string().max(16_384);
const longText = z.string().max(1_048_576);
const taskPrompt = z.string().max(65_536);
const uri = z.string().max(16_384).url();

const questionOption = z.object({
  id,
  label: shortText,
}).strip();

const question = z.object({
  id,
  prompt: shortText,
  options: z.array(questionOption).max(256).optional(),
  allowMultiple: z.boolean().optional(),
}).strip();

const todo = z.object({
  id: id.optional(),
  content: shortText.optional(),
  title: shortText.optional(),
  status: z.string().max(64).optional(),
}).strip();

const phase = z.object({
  name: shortText.optional(),
  todos: z.array(todo).max(2_000).optional(),
}).strip();

export const cursorAskQuestionRequestSchema = z.object({
  toolCallId: id.optional(),
  title: shortText.optional(),
  questions: z.array(question).min(1).max(256),
}).strip();

export const cursorCreatePlanRequestSchema = z.object({
  toolCallId: id.optional(),
  name: shortText.optional(),
  overview: longText.optional(),
  isProject: z.boolean().optional(),
  plan: longText.optional(),
  todos: z.array(todo).max(2_000).optional(),
  phases: z.array(phase).max(256).optional(),
}).strip();

export const cursorUpdateTodosRequestSchema = z.object({
  toolCallId: id.optional(),
  merge: z.boolean().optional(),
  todos: z.array(todo).max(2_000),
}).strip();

export const cursorTaskNotificationSchema = z.object({
  toolCallId: opaqueId.optional(),
  description: shortText.optional(),
  prompt: taskPrompt.optional(),
  subagentType: z.union([
    shortText,
    z.object({ custom: shortText }).strip(),
  ]).optional(),
  model: shortText.optional(),
  agentId: id.optional(),
  durationMs: z.number().finite().nonnegative().max(2_592_000_000).optional(),
}).strip();

export const cursorGenerateImageNotificationSchema = z.object({
  toolCallId: id.optional(),
  filePath: shortText.optional(),
  description: longText.optional(),
  referenceImagePaths: z.array(shortText).max(64).optional(),
}).strip();

export const cursorAskQuestionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('answered'),
      answers: z.array(z.object({
        questionId: id,
        selectedOptionIds: z.array(id).max(256),
      }).strip()).max(256),
    }).strip(),
    z.object({ outcome: z.literal('skipped'), reason: shortText.optional() }).strip(),
    z.object({ outcome: z.literal('cancelled') }).strip(),
  ]),
}).strip();

export const cursorCreatePlanResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('accepted'), planUri: uri.optional() }).strip(),
    z.object({ outcome: z.literal('rejected'), reason: shortText.optional() }).strip(),
    z.object({ outcome: z.literal('cancelled') }).strip(),
  ]),
}).strip();

export type CursorAskQuestionRequest = z.infer<typeof cursorAskQuestionRequestSchema>;
export type CursorCreatePlanRequest = z.infer<typeof cursorCreatePlanRequestSchema>;
export type CursorUpdateTodosRequest = z.infer<typeof cursorUpdateTodosRequestSchema>;
export type CursorTaskNotification = z.infer<typeof cursorTaskNotificationSchema>;
export type CursorGenerateImageNotification = z.infer<typeof cursorGenerateImageNotificationSchema>;
export type CursorAskQuestionResponse = z.infer<typeof cursorAskQuestionResponseSchema>;
export type CursorCreatePlanResponse = z.infer<typeof cursorCreatePlanResponseSchema>;
