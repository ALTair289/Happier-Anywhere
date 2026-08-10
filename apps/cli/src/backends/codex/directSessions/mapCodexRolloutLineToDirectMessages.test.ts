import { describe, expect, it } from 'vitest';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';

function mapLine(lineValue: unknown, lineStartOffsetBytes = 42, useEventUserMessageProjection = true) {
  return mapCodexRolloutLineToDirectMessages({
    fileRelPath: 'sessions/rollout.jsonl',
    lineStartOffsetBytes,
    lineValue,
    actions: mapCodexRolloutEventToActions(lineValue, { debug: false }),
    useEventUserMessageProjection,
  });
}

describe('mapCodexRolloutLineToDirectMessages', () => {
  it('uses the exact Codex client id for a durable user-message projection', () => {
    const lineValue = {
      type: 'event_msg',
      timestamp: '2026-08-09T01:02:03.000Z',
      payload: {
        type: 'user_message',
        client_id: 'client-local-1',
        message: 'same prompt',
      },
    };

    expect(mapLine(lineValue)).toEqual([
      expect.objectContaining({
        localId: 'client-local-1',
        raw: {
          role: 'user',
          content: { type: 'text', text: 'same prompt' },
        },
      }),
    ]);
  });

  it('preserves an opaque client id byte-for-byte', () => {
    const [item] = mapLine({
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: '  exact-id  ',
        message: 'same prompt',
      },
    });

    expect(item?.localId).toBe('  exact-id  ');
  });

  it('keeps two identical same-turn inputs distinct by client id', () => {
    const first = mapLine({
      type: 'event_msg',
      payload: { type: 'user_message', client_id: 'client-local-1', message: 'same prompt' },
    }, 42);
    const second = mapLine({
      type: 'event_msg',
      payload: { type: 'user_message', client_id: 'client-local-2', message: 'same prompt' },
    }, 84);

    expect([...first, ...second].map((item) => item.localId)).toEqual([
      'client-local-1',
      'client-local-2',
    ]);
  });

  it('keeps native terminal input without a client id using its stable offset identity', () => {
    const [item] = mapLine({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'typed in Codex' },
    });

    expect(item?.localId).toBe(item?.id);
    expect(item?.raw).toEqual({
      role: 'user',
      content: { type: 'text', text: 'typed in Codex' },
    });
  });

  it('does not also project the model-input response item for the same user input', () => {
    const lineValue = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'same prompt' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      },
    };

    expect(mapLine(lineValue)).toEqual([]);
  });

  it('uses the canonical event text once for a multi-part model input', () => {
    const responseItem = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'first part' },
          { type: 'input_text', text: 'second part' },
        ],
      },
    };
    const eventMessage = {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: 'client-multipart-1',
        message: 'first partsecond part',
      },
    };

    expect(mapLine(responseItem)).toEqual([]);
    expect(mapLine(eventMessage, 84)).toEqual([
      expect.objectContaining({
        localId: 'client-multipart-1',
        raw: {
          role: 'user',
          content: { type: 'text', text: 'first partsecond part' },
        },
      }),
    ]);
  });

  it('does not leak response-item attachment path annotations into the canonical event row', () => {
    const privatePath = 'C:\\private\\screenshots\\capture.png';
    const responseItem = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect this image' },
          { type: 'input_text', text: `attached image: ${privatePath}` },
          { type: 'input_image', image_url: `file:///${privatePath}` },
        ],
      },
    };
    const eventMessage = {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: 'client-image-1',
        message: 'inspect this image',
        local_images: [privatePath],
      },
    };

    expect(mapLine(responseItem)).toEqual([]);
    const projected = mapLine(eventMessage, 84);
    expect(projected).toEqual([
      expect.objectContaining({
        localId: 'client-image-1',
        raw: {
          role: 'user',
          content: { type: 'text', text: 'inspect this image' },
        },
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain(privatePath);
  });

  it('keeps the legacy response-item user row when exact event projection is unavailable', () => {
    const lineValue = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'legacy prompt' }],
      },
    };

    expect(mapLine(lineValue, 42, false)).toEqual([
      expect.objectContaining({
        raw: {
          role: 'user',
          content: { type: 'text', text: 'legacy prompt' },
        },
      }),
    ]);
  });

  it('does not add an event user row in legacy projection mode', () => {
    const lineValue = {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: 'new-field-on-unknown-version',
        message: 'legacy prompt',
      },
    };

    expect(mapLine(lineValue, 84, false)).toEqual([]);
  });

  it('does not render an injected subagent notification as a user message', () => {
    const lineValue = {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: 'subagent-notification-local-id',
        message: '<subagent_notification>{"agent_id":"child-1","status":{"completed":"done"}}</subagent_notification>',
      },
    };

    expect(mapLine(lineValue)).toEqual([]);
  });
});
