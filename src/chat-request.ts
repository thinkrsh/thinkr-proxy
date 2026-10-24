// Turns the body of POST /api/chat into a valid ChatRequest, or throws a ProxyError.
import { LIMITS } from './config/limits.js';
import { MESSAGES } from './config/messages.js';
import { chatRequestSchema, type ChatMessage, type ChatRequest } from './contract.js';
import { parseBody } from './lib/body.js';
import { ProxyError } from './lib/errors.js';

export function parseChatRequest(body: unknown): ChatRequest {
  const request = parseBody(chatRequestSchema, body);
  assertTurnOrder(request.messages);
  assertTotalSize(request.messages);
  assertImageCount(request.messages);
  return request;
}

/** The photos of all the messages of a chat (23 Oct 2026). */
export function imageCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0);
}

function assertTurnOrder(messages: readonly ChatMessage[]): void {
  if (messages[0]?.role !== 'user') throw new ProxyError('invalid_request', MESSAGES.firstMessage);
  if (messages.at(-1)?.role !== 'user') {
    throw new ProxyError('invalid_request', MESSAGES.lastMessage);
  }
  const repeats = messages.some((message, index) => message.role === messages[index - 1]?.role);
  if (repeats) throw new ProxyError('invalid_request', MESSAGES.alternation);
}

function assertTotalSize(messages: readonly ChatMessage[]): void {
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total > LIMITS.maxTotalChars) throw new ProxyError('invalid_request', MESSAGES.chatTooLong);
}

function assertImageCount(messages: readonly ChatMessage[]): void {
  if (imageCount(messages) > LIMITS.maxImagesPerChat) {
    throw new ProxyError('invalid_request', MESSAGES.tooManyImagesInChat);
  }
}
