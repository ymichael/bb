export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

const FORCE_CLOSE_CONNECTIONS_AFTER_MS = 100;

function closeIdleConnections(server: ClosableHttpServer): void {
  try {
    server.closeIdleConnections?.();
  } catch {
    // Ignore server implementations that do not support idle connection closing.
  }
}

function closeAllConnections(server: ClosableHttpServer): void {
  try {
    server.closeAllConnections?.();
  } catch {
    // Ignore server implementations that do not support force-closing sockets.
  }
}

export function closeHttpServer(
  server: ClosableHttpServer | undefined,
): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolveClose) => {
    let finished = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (forceTimer !== null) {
        clearTimeout(forceTimer);
      }
      resolveClose();
    };

    try {
      server.close(() => {
        finish();
      });
    } catch {
      finish();
      return;
    }

    closeIdleConnections(server);

    // Let the restart response flush, then drop long-poll and keep-alive sockets
    // so restart is not delayed by lingering daemon clients.
    forceTimer = setTimeout(() => {
      closeIdleConnections(server);
      closeAllConnections(server);
    }, FORCE_CLOSE_CONNECTIONS_AFTER_MS);
    forceTimer.unref?.();
  });
}
