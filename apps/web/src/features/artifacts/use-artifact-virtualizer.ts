/**
 * React bridge for TanStack Virtual's framework-neutral core.
 *
 * The React adapter's useVirtualizer API is flagged as incompatible with
 * React Compiler memoization. This adapter opts out of compilation because
 * Virtualizer is intentionally mutable, but leaves the surrounding renderer
 * eligible for compilation. Sync scroll notifications flush immediately to
 * keep the visible window aligned with the scroll position.
 */
import { flushSync } from "react-dom";
import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type PartialKeys,
  type VirtualizerOptions,
} from "@tanstack/react-virtual";

const useIsomorphicLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

type ArtifactVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = PartialKeys<
  VirtualizerOptions<TScrollElement, TItemElement>,
  "observeElementRect" | "observeElementOffset" | "scrollToFn"
>;

export function useArtifactVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: ArtifactVirtualizerOptions<TScrollElement, TItemElement>,
): Virtualizer<TScrollElement, TItemElement> {
  "use no memo";

  const rerender = useReducer((value: number) => value + 1, 0)[1];
  const resolvedOptions = {
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    ...options,
    onChange: (
      instance: Virtualizer<TScrollElement, TItemElement>,
      sync: boolean,
    ) => {
      if (sync) flushSync(rerender);
      else rerender();
      options.onChange?.(instance, sync);
    },
  };
  const [instance] = useState(
    () => new Virtualizer<TScrollElement, TItemElement>(resolvedOptions),
  );

  instance.setOptions(resolvedOptions);
  useIsomorphicLayoutEffect(() => instance._didMount(), []);
  useIsomorphicLayoutEffect(() => instance._willUpdate());

  return instance;
}
