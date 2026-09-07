import { createElement, type ComponentType } from "react";

const warnedNames = new Set<string>();

function warnDeprecatedMember(oldName: string, newName: string): void {
  if (warnedNames.has(oldName)) return;
  warnedNames.add(oldName);
  console.warn(`${oldName} is deprecated; use ${newName}. Removed in bb 0.42`);
}

const componentAliases = new Map<string, ComponentType<never>>();

export function installDeprecatedAliases<T extends object>(
  target: T,
  aliases: Readonly<Record<string, keyof T & string>>,
): T {
  for (const [oldName, newName] of Object.entries(aliases)) {
    Object.defineProperty(target, oldName, {
      configurable: true,
      enumerable: false,
      get() {
        const existing = componentAliases.get(oldName);
        if (existing !== undefined) return existing;
        const Member = target[newName] as ComponentType<never>;
        function DeprecatedMember(props: Record<string, unknown>) {
          warnDeprecatedMember(oldName, newName);
          return createElement(Member, props as never);
        }
        componentAliases.set(oldName, DeprecatedMember);
        return DeprecatedMember;
      },
    });
  }
  return target;
}

export function deprecatedAlias<Args extends unknown[], Result>(
  oldName: string,
  newName: string,
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    warnDeprecatedMember(oldName, newName);
    return fn(...args);
  };
}

const originalAliases = new WeakMap<ComponentType, ComponentType>();

export function deprecatedOriginalAlias(
  Original: ComponentType,
): ComponentType {
  const existing = originalAliases.get(Original);
  if (existing !== undefined) return existing;
  function ExperimentalOriginal() {
    warnDeprecatedMember("experimental_Original", "Original");
    return createElement(Original);
  }
  originalAliases.set(Original, ExperimentalOriginal);
  return ExperimentalOriginal;
}

export function resetDeprecatedAliasWarningsForTests(): void {
  warnedNames.clear();
}
