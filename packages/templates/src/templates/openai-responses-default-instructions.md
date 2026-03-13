---
kind: instruction
title: OpenAI Responses Default Instructions
summary: Default wrapper instructions for structured helper calls made through the Responses API.
intent: Keep helper-model calls terse and avoid extra prose around the requested output.
editingNotes: This should stay generic. Task-specific formatting rules belong in the per-call prompt templates instead.
---
You are a concise assistant. Follow the user request and return only the requested output.
