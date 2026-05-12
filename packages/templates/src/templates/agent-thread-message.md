---
kind: prompt
title: Agent Thread Message
summary: Wraps a bb CLI message from one agent thread to another.
intent: Tell the receiving agent which thread sent the message and how to reply.
editingNotes: Keep the response command in the prefix so standard agent instructions do not need special cross-thread message guidance.
variables:
  senderThreadId: The thread ID that sent the message.
  messageText: The original message text sent by the agent.
---
[bb message from thread:{{senderThreadId}}; reply with `bb thread tell {{senderThreadId}} "<your response>"`]

{{messageText}}
