function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export async function waitForServerHealth(
  serverUrl: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await wait(100);
  }

  throw new Error(`Timed out waiting for server health at ${serverUrl}/health`);
}
