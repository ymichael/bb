UPDATE environment_agent_sessions
SET transport_kind = 'http-long-poll'
WHERE transport_kind = 'websocket';
