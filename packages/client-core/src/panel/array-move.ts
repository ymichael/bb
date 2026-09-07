export function arrayMove<T>(
  array: readonly T[],
  from: number,
  to: number,
): T[] {
  const result = [...array];
  const [moved] = result.splice(from, 1);
  if (moved === undefined) {
    return result;
  }
  result.splice(to < 0 ? result.length + to : to, 0, moved);
  return result;
}
