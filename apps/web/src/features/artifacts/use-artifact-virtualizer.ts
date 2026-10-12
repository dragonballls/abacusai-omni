"use no memo";

/**
 * TanStack Virtual exposes a mutable virtualizer instance whose methods cannot
 * safely be memoized by React Compiler. Keep the opt-out at this adapter
 * boundary; callers can continue using normal hooks and compiler checks stay
 * enabled for the rest of the renderer.
 */
import { useVirtualizer } from "@tanstack/react-virtual";

export function useArtifactVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: Parameters<typeof useVirtualizer<TScrollElement, TItemElement>>[0]
): ReturnType<typeof useVirtualizer<TScrollElement, TItemElement>> {
  return useVirtualizer<TScrollElement, TItemElement>(options);
}
