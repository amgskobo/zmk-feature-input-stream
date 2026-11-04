import type {
  BehaviorBinding,
  Keymap,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import {
  getEffectiveBinding,
  isValidActiveLayerMask,
  isValidLayerIndex,
} from "../../web/src/bindings";

const base: BehaviorBinding = { behaviorId: 10, param1: 4, param2: 0 };
const middle: BehaviorBinding = { behaviorId: 20, param1: 5, param2: 0 };
const transparent: BehaviorBinding = { behaviorId: 30, param1: 0, param2: 0 };
const metadata = new Map<number, GetBehaviorDetailsResponse>([
  [30, { id: 30, displayName: "Transparent" } as GetBehaviorDetailsResponse],
]);

function fixture(bindings = [base, middle, transparent]) {
  let reads = 0;
  const keymap: Keymap = {
    layers: bindings.map((binding, id) => ({
      id,
      name: `L${id}`,
      bindings: [binding],
    })),
  };
  keymap.layers = new Proxy(keymap.layers, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        reads++;
        if (reads > bindings.length) throw new Error("unbounded layer lookup");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { keymap, reads: () => reads };
}

it("accepts only first/last loaded indices and rejects malformed or empty ranges", () => {
  expect(isValidLayerIndex(0, 2)).toBe(true);
  expect(isValidLayerIndex(1, 2)).toBe(true);
  for (const index of [-1, 0.5, 2, 0xffffffff, Infinity, NaN]) {
    expect(isValidLayerIndex(index, 2)).toBe(false);
  }
  expect(isValidLayerIndex(0, 0)).toBe(false);
});

it("retains first/last-layer selection and transparent fallback", () => {
  expect(getEffectiveBinding(fixture().keymap, 0, 0, metadata)).toBe(base);
  expect(getEffectiveBinding(fixture().keymap, 0, 1, metadata)).toBe(middle);
  expect(getEffectiveBinding(fixture().keymap, 0, 2, metadata, 0b111)).toBe(
    middle,
  );
});

it("bounds a stale uint32 index to the loaded layers and preserves the binding", () => {
  const { keymap, reads } = fixture();
  expect(getEffectiveBinding(keymap, 0, 0xffffffff, metadata, 0b111)).toBe(
    middle,
  );
  expect(reads()).toBeLessThanOrEqual(3);
});

it("returns no binding for empty layers, invalid indices or absent positions", () => {
  expect(
    getEffectiveBinding(fixture([]).keymap, 0, 0xffffffff, metadata),
  ).toBeNull();
  for (const index of [-1, 0.5, NaN, Infinity]) {
    expect(
      getEffectiveBinding(fixture().keymap, 0, index, metadata),
    ).toBeNull();
  }
  expect(getEffectiveBinding(fixture().keymap, 1, 2, metadata)).toBeNull();
});

it("keeps an all-transparent fallback bounded and independent of another position", () => {
  const { keymap, reads } = fixture([transparent, transparent, transparent]);
  expect(
    getEffectiveBinding(keymap, 0, 0xffffffff, metadata, 0b111),
  ).toBeNull();
  expect(reads()).toBe(3);
  expect(getEffectiveBinding(fixture().keymap, 0, 0, metadata)).toBe(base);
});

it("skips inactive intermediate layers and preserves the active base", () => {
  expect(getEffectiveBinding(fixture().keymap, 0, 2, metadata, 0b101)).toBe(
    base,
  );
  expect(getEffectiveBinding(fixture().keymap, 0, 2, metadata, 0b110)).toBe(
    middle,
  );
  expect(
    getEffectiveBinding(
      fixture([base, transparent, transparent]).keymap,
      0,
      2,
      metadata,
      0b110,
    ),
  ).toBeNull();
});

it("does not invent transparent fallback for firmware without an active-layer mask", () => {
  expect(getEffectiveBinding(fixture().keymap, 0, 2, metadata)).toBeNull();
  expect(getEffectiveBinding(fixture().keymap, 0, 1, metadata)).toBe(middle);
});

it("validates the top bit and bounds of uint32 layer masks including bit 31", () => {
  expect(isValidActiveLayerMask(0b101, 2, 3)).toBe(true);
  expect(isValidActiveLayerMask(0x80000001, 31, 32)).toBe(true);
  for (const mask of [0, -1, 1.5, 0x100000000, NaN, Infinity, 0b001, 0b1111]) {
    expect(isValidActiveLayerMask(mask, 2, 3)).toBe(false);
  }
  expect(isValidActiveLayerMask(1, 0, 0)).toBe(false);
  expect(isValidActiveLayerMask(1, 32, 33)).toBe(false);
});
