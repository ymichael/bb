export function withWriteAfterFirstRead<T extends object>(
  connection: T,
  onFirstRead: () => void,
): T {
  let pending: (() => void) | null = onFirstRead;
  const wrapBuilder = (builder: object): object =>
    new Proxy(builder, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...callArgs: never[]) => {
          const result = Reflect.apply(value, target, callArgs);
          if (property === "get") {
            const trigger = pending;
            pending = null;
            trigger?.();
            return result;
          }
          return result !== null && typeof result === "object"
            ? wrapBuilder(result)
            : result;
        };
      },
    });
  return new Proxy(connection, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select" || typeof value !== "function") {
        return value;
      }
      return (...callArgs: never[]) =>
        wrapBuilder(Reflect.apply(value, target, callArgs));
    },
  });
}
