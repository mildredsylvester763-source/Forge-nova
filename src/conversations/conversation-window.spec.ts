import { BadRequestException } from '@nestjs/common';
import { ConversationService } from './conversation.service';

describe('conversation message window law (shared by the JWT and genapi listings)', () => {
  it('defaults take to 100 when absent', () => {
    expect(ConversationService.parseMessageTake(undefined)).toBe(100);
  });

  it('accepts every integer take between 1 and 100', () => {
    expect(ConversationService.parseMessageTake('1')).toBe(1);
    expect(ConversationService.parseMessageTake('42')).toBe(42);
    expect(ConversationService.parseMessageTake('100')).toBe(100);
  });

  it('refuses take values outside the window with the exact 400 message', () => {
    for (const raw of ['0', '101', '-1', '1.5', 'abc', '']) {
      expect(() => ConversationService.parseMessageTake(raw)).toThrow(BadRequestException);
      expect(() => ConversationService.parseMessageTake(raw)).toThrow('take must be an integer between 1 and 100.');
    }
  });

  it('treats an absent or empty cursor as no cursor', () => {
    expect(ConversationService.parseMessageCursor(undefined)).toBeUndefined();
    expect(ConversationService.parseMessageCursor('')).toBeUndefined();
  });

  it('parses a real cursor date unchanged', () => {
    const parsed = ConversationService.parseMessageCursor('2026-10-31T07:00:00.000Z');
    expect(parsed ? parsed.toISOString() : '').toBe('2026-10-31T07:00:00.000Z');
  });

  it('refuses a malformed cursor with the exact 400 message', () => {
    for (const raw of ['not-a-date', '2026-13-45']) {
      expect(() => ConversationService.parseMessageCursor(raw)).toThrow(BadRequestException);
      expect(() => ConversationService.parseMessageCursor(raw)).toThrow('Invalid message pagination cursor.');
    }
  });
});