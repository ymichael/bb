export function humanizeTransportError(error: Error, host: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  let reason: string;
  if (code === "ECONNREFUSED") reason = "connection refused";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    reason = "host not found";
  else if (
    code === "ETIMEDOUT" ||
    /timed out|timeout|ETIMEDOUT/i.test(error.message)
  )
    reason = "timed out";
  else if (code === "ECONNRESET") reason = "connection reset";
  else reason = error.message;
  return `can't reach ${host} — ${reason}`;
}
