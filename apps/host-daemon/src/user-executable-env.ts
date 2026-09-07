export function userExecutableProcessOptions(shellEnv: NodeJS.ProcessEnv): {
  shellPath?: string;
} {
  const shellPath = shellEnv.PATH;
  return shellPath === undefined ? {} : { shellPath };
}
