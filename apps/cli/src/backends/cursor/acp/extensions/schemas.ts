import { z } from 'zod';

const id = z.string().trim().min(1).max(512);
const shortText = z.string().max(16_384);
const longText = z.string().max(1_048_576);

const questionOption = z.object({
  id: id.optional(),
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
  questions: z.array(question).max(256),
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
  toolCallId: id.optional(),
  description: shortText.optional(),
  prompt: longText.optional(),
  subagentType: shortText.optional(),
  customSubagentType: shortText.optional(),
  model: shortText.optional(),
  agentId: id.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
}).strip();

export const cursorGenerateImageNotificationSchema = z.object({
  toolCallId: id.optional(),
  path: longText.optional(),
  description: longText.optional(),
  generationId: id.optional(),
  referenceImages: z.array(longText).max(64).optional(),
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
    z.object({ outcome: z.literal('accepted'), planUri: longText.optional() }).strip(),
    z.object({ outcome: z.literal('rejected'), reason: shortText.optional() }).strip(),
    z.object({ outcome: z.literal('cancelled') }).strip(),
  ]),
}).strip();

export type CursorAskQuestionRequest = z.infer<typeof cursorAskQuestionRequestSchema>;
export type CursorCreatePlanRequest = z.infer<typeof cursorCreatePlanRequestSchema>;
export type CursorUpdateTodosRequest = z.infer<typeof cursorUpdateTodosRequestSchema>;
export type CursorAskQuestionResponse = z.infer<typeof cursorAskQuestionResponseSchema>;
export type CursorCreatePlanResponse = z.infer<typeof cursorCreatePlanResponseSchema>;
