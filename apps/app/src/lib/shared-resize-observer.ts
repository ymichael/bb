export interface SharedResizePhases<T> {
  read: (entry: ResizeObserverEntry | undefined) => T;
  write: (value: T) => void;
}

interface RegisteredPhases {
  read: (entry: ResizeObserverEntry | undefined) => () => void;
}

interface PhaseDispatch {
  registration: RegisteredPhases;
  entry: ResizeObserverEntry | undefined;
}

const phasesByTarget = new Map<Element, Set<RegisteredPhases>>();
let sharedResizeObserver: ResizeObserver | null = null;

function collectDispatches(
  entries: readonly ResizeObserverEntry[],
): PhaseDispatch[] {
  if (entries.length === 0) {
    return [...phasesByTarget.values()].flatMap((registrations) =>
      [...registrations].map((registration) => ({
        registration,
        entry: undefined,
      })),
    );
  }
  const dispatches: PhaseDispatch[] = [];
  for (const entry of entries) {
    for (const registration of phasesByTarget.get(entry.target) ?? []) {
      dispatches.push({ registration, entry });
    }
  }
  return dispatches;
}

function dispatchPhased(dispatches: readonly PhaseDispatch[]): void {
  const writes = dispatches.map(({ registration, entry }) =>
    registration.read(entry),
  );
  for (const write of writes) {
    write();
  }
}

function getSharedResizeObserver(): ResizeObserver {
  sharedResizeObserver ??= new ResizeObserver((entries) => {
    dispatchPhased(collectDispatches(entries));
  });
  return sharedResizeObserver;
}

export function observeSharedResize<T>(
  target: Element,
  phases: SharedResizePhases<T>,
): () => void {
  const registration: RegisteredPhases = {
    read: (entry) => {
      const value = phases.read(entry);
      return () => phases.write(value);
    },
  };
  let registrations = phasesByTarget.get(target);
  const isFirstForTarget = registrations === undefined;
  if (registrations === undefined) {
    registrations = new Set();
    phasesByTarget.set(target, registrations);
  }
  registrations.add(registration);
  if (isFirstForTarget) {
    getSharedResizeObserver().observe(target);
  }

  return () => {
    const currentRegistrations = phasesByTarget.get(target);
    currentRegistrations?.delete(registration);
    if (currentRegistrations?.size === 0) {
      phasesByTarget.delete(target);
      sharedResizeObserver?.unobserve?.(target);
      if (phasesByTarget.size === 0) {
        sharedResizeObserver?.disconnect?.();
        sharedResizeObserver = null;
      }
    }
  };
}

export function observedBorderBoxBlockSize(
  entry: ResizeObserverEntry,
): number | undefined {
  return entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height;
}
