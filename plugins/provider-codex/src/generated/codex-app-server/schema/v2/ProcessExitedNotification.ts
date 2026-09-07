

export type ProcessExitedNotification = {
processHandle: string,
exitCode: number,
stdout: string,
stdoutCapReached: boolean,
stderr: string,
stderrCapReached: boolean, };
