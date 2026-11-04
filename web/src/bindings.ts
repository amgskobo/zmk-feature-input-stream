import type {
  BehaviorBinding,
  Keymap,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";

export function isValidLayerIndex(index: number, layerCount: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < layerCount;
}

export function isValidActiveLayerMask(
  mask: number,
  top: number,
  count: number
): boolean {
  return (
    Number.isInteger(mask) &&
    mask > 0 &&
    mask <= 0xffffffff &&
    isValidLayerIndex(top, count) &&
    top < 32 &&
    ((mask >>> top) & 1) === 1 &&
    (top === 31 || mask < 2 ** (top + 1))
  );
}

/** Walk loaded active indices only. Without a mask, transparent fallback is unknown. */
export function getEffectiveBinding(
  keymap: Keymap,
  position: number,
  fromLayer: number,
  behaviorMap: Map<number, GetBehaviorDetailsResponse>,
  activeLayerMask: number | null = null
): BehaviorBinding | null {
  if (!Number.isInteger(fromLayer) || fromLayer < 0) return null;
  const top = Math.min(fromLayer, keymap.layers.length - 1);
  for (let i = top; i >= 0; i--) {
    if (activeLayerMask === null && i !== top) return null;
    if (
      activeLayerMask !== null &&
      (i >= 32 || ((activeLayerMask >>> i) & 1) === 0)
    )
      continue;
    const layer = keymap.layers[i];
    if (!layer || position >= layer.bindings.length) continue;
    const binding = layer.bindings[position];
    const details = behaviorMap.get(binding.behaviorId);
    const transparent =
      details?.displayName.toLowerCase().startsWith("transparent") ?? false;
    if (!transparent) return binding;
  }
  return null;
}
