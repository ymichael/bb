const maxCapturedOutputCharacters = 20_000;

export function appendOutput(chunks, chunk) {
  chunks.push(String(chunk));
  let totalLength = chunks.reduce((total, value) => total + value.length, 0);
  while (totalLength > maxCapturedOutputCharacters && chunks.length > 1) {
    const removed = chunks.shift();
    totalLength -= removed.length;
  }
}

export function formatProcessOutput({ stdout, stderr }) {
  const stdoutText = stdout.join("").trim();
  const stderrText = stderr.join("").trim();
  return [
    stdoutText.length > 0 ? `stdout:\n${stdoutText}` : "",
    stderrText.length > 0 ? `stderr:\n${stderrText}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
