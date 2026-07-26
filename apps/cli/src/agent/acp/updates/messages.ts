import { logger } from '@/ui/logger';

import {
  emitSessionMediaExtractionResult,
  extractAcpMediaContentBlocks,
} from '../media/extractAcpMediaContentBlocks';
import { extractTextFromContentBlock } from './content';
import { DEFAULT_IDLE_TIMEOUT_MS, type HandlerContext, type HandlerResult, type SessionUpdate } from './types';

/**
 * Handle agent_message_chunk update (text output from model).
 */
export function handleAgentMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  const mediaResult = extractAcpMediaContentBlocks(update.content, {
    source: 'acp-content',
    originSource: 'acp-content',
  });
  if (typeof text !== 'string' || text.length === 0) {
    const handledMedia = emitSessionMediaExtractionResult({
      result: mediaResult,
      source: 'acp-content',
      emit: ctx.emit,
    });
    return { handled: handledMedia };
  }
  logger.debug(`[AcpBackend] Received message chunk (length: ${text.length})`);
  ctx.emit({
    type: 'model-output',
    textDelta: text,
  });
  emitSessionMediaExtractionResult({
    result: mediaResult,
    source: 'acp-content',
    emit: ctx.emit,
  });

  // Reset idle timeout - more chunks are coming.
  ctx.clearIdleTimeout();

  // Set timeout to emit 'idle' after a short delay when no more chunks arrive.
  const idleTimeoutMs =
    (ctx.toolCallCountSincePrompt === 0
      ? ctx.transport.getPreToolCallIdleTimeoutMs?.()
      : null) ??
    ctx.transport.getIdleTimeout?.() ??
    DEFAULT_IDLE_TIMEOUT_MS;
  ctx.setIdleTimeout(() => {
    if (ctx.toolCalls.activeSize === 0) {
      logger.debug('[AcpBackend] No more chunks received, emitting idle status');
      ctx.emitIdleStatus();
    } else {
      logger.debug(`[AcpBackend] Delaying idle status - ${ctx.toolCalls.activeSize} active tool calls`);
    }
  }, idleTimeoutMs);

  return { handled: true };
}

/**
 * Handle agent_thought_chunk update (Gemini's thinking/reasoning).
 */
export function handleAgentThoughtChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  if (!text.trim()) return { handled: true };

  // Log thinking chunks when tool calls are active.
  if (ctx.toolCalls.activeSize > 0) {
    const activeToolCallsList = ctx.toolCalls.activeCallIds();
    logger.debug(
      `[AcpBackend] 💭 Thinking chunk received (${text.length} chars) during active tool calls: ${activeToolCallsList.join(', ')}`,
    );
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  // Thinking chunks are liveness just like visible assistant chunks.
  ctx.clearIdleTimeout();
  const idleTimeoutMs =
    (ctx.toolCallCountSincePrompt === 0
      ? ctx.transport.getPreToolCallIdleTimeoutMs?.()
      : null) ??
    ctx.transport.getIdleTimeout?.() ??
    DEFAULT_IDLE_TIMEOUT_MS;
  ctx.setIdleTimeout(() => {
    if (ctx.toolCalls.activeSize === 0) {
      logger.debug('[AcpBackend] No more thought chunks received, emitting idle status');
      ctx.emitIdleStatus();
    } else {
      logger.debug(`[AcpBackend] Delaying idle status after thought chunk - ${ctx.toolCalls.activeSize} active tool calls`);
    }
  }, idleTimeoutMs);

  return { handled: true };
}

export function handleUserMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'user_message_chunk',
    payload: { text },
  });
  return { handled: true };
}

/**
 * Handle legacy messageChunk format.
 */
export function handleLegacyMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext,
): HandlerResult {
  if (!update.messageChunk) {
    return { handled: false };
  }

  const chunk = update.messageChunk;
  if (chunk.textDelta) {
    ctx.emit({
      type: 'model-output',
      textDelta: chunk.textDelta,
    });
    return { handled: true };
  }

  return { handled: false };
}
