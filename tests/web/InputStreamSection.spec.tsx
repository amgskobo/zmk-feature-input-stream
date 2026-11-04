import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";
import { InputStreamSection, SUBSYSTEM_IDENTIFIER } from "../../web/src/App";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import type { CustomNotification } from "@zmkfirmware/zmk-studio-ts-client/custom";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import {
  Notification,
  Response,
} from "../../web/src/proto/zmk/input_stream/input_stream";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn().mockResolvedValue({}),
  MetaError: class MetaError extends Error {
    condition: number;
    constructor(condition: number) {
      super("meta error");
      this.condition = condition;
    }
  },
}));

const mockCallRpc = call_rpc as jest.Mock;

function makeUnlockError() {
  const { MetaError } = jest.requireMock(
    "@zmkfirmware/zmk-studio-ts-client",
  ) as { MetaError: new (c: number) => Error };
  return new MetaError(ErrorConditions.UNLOCK_REQUIRED);
}

const PROPS = { deviceName: "Test Device", disconnect: jest.fn() };

function renderWithApp(subsystems: string[] = [SUBSYSTEM_IDENTIFIER]) {
  const mockZMKApp = createConnectedMockZMKApp({
    deviceName: "Test Device",
    subsystems,
  });
  return render(
    <ZMKAppProvider value={mockZMKApp}>
      <InputStreamSection {...PROPS} />
    </ZMKAppProvider>,
  );
}

let callRPCSpy: jest.SpyInstance;

beforeEach(() => {
  // call_rpc: used by data loading (keymap/behaviors)
  mockCallRpc.mockResolvedValue({});
  // ZMKCustomSubsystem.callRPC: used by stream enable/disable
  callRPCSpy = jest
    .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
    .mockResolvedValue(null);
});

afterEach(() => {
  mockCallRpc.mockReset();
  callRPCSpy.mockRestore();
});

describe("InputStreamSection Component", () => {
  describe("With Subsystem", () => {
    it("renders device name and stream button", () => {
      renderWithApp();
      expect(screen.getByText("Test Device")).toBeInTheDocument();
      expect(
        screen.queryByText(/Enable Stream|Disable Stream/i),
      ).toBeInTheDocument();
    });

    it("auto-starts streaming after loading completes", async () => {
      renderWithApp();
      await waitFor(() =>
        expect(screen.getByText(/Disable Stream/i)).toBeInTheDocument(),
      );
    });

    it("shows unlock-pending info bar when UNLOCK_REQUIRED during load", async () => {
      // Loading fails with UNLOCK_REQUIRED
      mockCallRpc.mockRejectedValue(makeUnlockError());
      renderWithApp();

      await waitFor(() =>
        expect(screen.getByText(/Studio is locked/i)).toBeInTheDocument(),
      );
      // Stream button should be disabled while loading retries
      expect(
        screen.getByText(/Enable Stream/i).closest("button"),
      ).toBeDisabled();
    });

    it("dismissing unlock info bar stops retry and shows load error", async () => {
      mockCallRpc.mockRejectedValue(makeUnlockError());
      renderWithApp();

      await waitFor(() =>
        expect(document.querySelector(".info-bar")).toBeInTheDocument(),
      );

      await act(async () => {
        const dismissBtn = document.querySelector(
          ".info-bar-dismiss",
        ) as HTMLButtonElement;
        await userEvent.click(dismissBtn);
      });

      expect(document.querySelector(".info-bar")).not.toBeInTheDocument();
      // Load error should appear after dismiss
      expect(document.querySelector(".error-bar")).toBeInTheDocument();
    });
  });

  describe("Without Subsystem", () => {
    it("should show 'No subsystem' warning", () => {
      renderWithApp([]);
      expect(screen.getByText(/No subsystem/i)).toBeInTheDocument();
    });
  });

  describe("Without ZMKAppContext", () => {
    it("should not render when ZMKAppContext is not provided", () => {
      const { container } = render(<InputStreamSection {...PROPS} />);
      expect(container.firstChild).toBeNull();
    });
  });
});

describe("Stream lifecycle", () => {
  beforeEach(() => {
    // Two physical keys and two layers; transport remains a controlled boundary.
    mockCallRpc.mockResolvedValue({
      keymap: {
        getPhysicalLayouts: {
          activeLayoutIndex: 0,
          layouts: [
            {
              name: "test",
              keys: [0, 100].map((x) => ({
                x,
                y: 0,
                width: 100,
                height: 100,
                r: 0,
                rx: 0,
                ry: 0,
              })),
            },
          ],
        },
        getKeymap: {
          layers: [0, 1].map((id) => ({
            id,
            name: `L${id}`,
            bindings: [0, 1].map(() => ({
              behaviorId: 99,
              param1: 4,
              param2: 0,
            })),
          })),
        },
      },
    });
  });

  function mount(
    app = createConnectedMockZMKApp({ subsystems: [SUBSYSTEM_IDENTIFIER] }),
  ) {
    const view = render(
      <ZMKAppProvider value={app}>
        <InputStreamSection {...PROPS} />
      </ZMKAppProvider>,
    );
    return { app, ...view };
  }

  function callback(app: ReturnType<typeof createConnectedMockZMKApp>) {
    const calls = (app.onNotification as jest.Mock).mock.calls;
    const customCalls = calls.filter(
      ([subscription]) => subscription.type === "custom",
    );
    return customCalls[customCalls.length - 1][0].callback as (
      n: CustomNotification,
    ) => void;
  }

  function send(
    cb: (n: CustomNotification) => void,
    pressed: boolean,
    position = 0,
  ) {
    act(() =>
      cb({
        subsystemIndex: 0,
        payload: Notification.encode(
          Notification.create({
            keyEvent: {
              position,
              pressed,
              behaviorId: 99,
              param1: 4,
              param2: 0,
            },
          }),
        ).finish(),
      }),
    );
  }

  function deferred() {
    let resolve!: (v: Uint8Array | null) => void;
    const promise = new Promise<Uint8Array | null>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function started() {
    await screen.findByRole("button", { name: "Disable Stream" });
  }

  function lock(
    app: ReturnType<typeof createConnectedMockZMKApp>,
    locked: boolean,
  ) {
    const calls = (app.onNotification as jest.Mock).mock.calls;
    const core = calls.filter(([subscription]) => subscription.type === "core");
    expect(core.length).toBeGreaterThan(0);
    act(() =>
      core[core.length - 1][0].callback({
        lockStateChanged: locked
          ? LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED
          : LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED,
      }),
    );
  }

  it("clears held keys on Studio lock and requires explicit enable after unlock", async () => {
    const { app } = mount();
    await started();
    send(callback(app), true);
    lock(app, true);
    expect(
      screen.getByRole("button", { name: "Enable Stream" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    send(callback(app), true);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    const count = callRPCSpy.mock.calls.length;
    lock(app, false);
    expect(callRPCSpy).toHaveBeenCalledTimes(count);
    await userEvent.click(
      screen.getByRole("button", { name: "Enable Stream" }),
    );
    await started();
    send(callback(app), true);
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
  });

  it("ignores an enable acknowledgement that arrives after Studio locking", async () => {
    const pending = deferred();
    callRPCSpy.mockReturnValueOnce(pending.promise);
    const { app } = mount();
    await waitFor(() => expect(callRPCSpy).toHaveBeenCalled());
    lock(app, true);
    await act(async () => pending.resolve(null));
    expect(
      screen.getByRole("button", { name: "Enable Stream" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disable Stream" }),
    ).not.toBeInTheDocument();
  });

  it("does not auto-enable when initial loading finishes after a lock and unlock", async () => {
    let resolve!: (value: object) => void;
    const pending = new Promise<object>((done) => {
      resolve = done;
    });
    mockCallRpc.mockReturnValueOnce(pending);
    const { app } = mount();
    await waitFor(() => expect(mockCallRpc).toHaveBeenCalledTimes(3));
    lock(app, true);
    lock(app, false);
    await act(async () => resolve({}));
    expect(callRPCSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Enable Stream" }),
    ).toBeInTheDocument();
  });

  it("decodes ordered independent keys and layers, and ignores malformed payloads", async () => {
    const { app } = mount();
    await started();
    const cb = callback(app);
    send(cb, true, 0);
    send(cb, true, 1);
    send(cb, false, 0);
    const keys = document.querySelectorAll(".keycap");
    expect(keys[0]).not.toHaveClass("keycap-pressed");
    expect(keys[1]).toHaveClass("keycap-pressed");
    act(() =>
      cb({
        subsystemIndex: 0,
        payload: Notification.encode(
          Notification.create({
            layerChange: { layerIndex: 1 },
          }),
        ).finish(),
      }),
    );
    expect(screen.getByText("Layer 1")).toBeInTheDocument();
    act(() => cb({ subsystemIndex: 0, payload: new Uint8Array([0xff]) }));
    expect(keys[1]).toHaveClass("keycap-pressed");
    send(cb, false, 1);
    expect(keys[1]).not.toHaveClass("keycap-pressed");
  });

  it("clears held keys on stop, ignores late notifications, and restarts cleanly", async () => {
    const { app } = mount();
    await started();
    const cb = callback(app);
    send(cb, true);
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Stream" }),
    );
    await screen.findByRole("button", { name: "Enable Stream" });
    expect(document.querySelector(".keycap")).not.toHaveClass("keycap-pressed");
    send(callback(app), true, 1);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Enable Stream" }),
    );
    await started();
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    send(callback(app), true, 1);
    expect(document.querySelectorAll(".keycap")[1]).toHaveClass(
      "keycap-pressed",
    );
  });

  it("accepts events before enable acknowledgement, then clears them if enable fails", async () => {
    const pending = deferred();
    callRPCSpy.mockReturnValueOnce(pending.promise);
    const { app } = mount();
    await waitFor(() => expect(callRPCSpy).toHaveBeenCalled());
    send(callback(app), true);
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
    await act(async () =>
      pending.resolve(
        Response.encode(
          Response.create({ error: { message: "denied" } }),
        ).finish(),
      ),
    );
    expect(screen.getByText(/denied/)).toBeInTheDocument();
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    send(callback(app), true);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Enable Stream" }),
    );
    await started();
    send(callback(app), true);
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
  });

  it("retains streaming on disable error and allows a successful retry", async () => {
    const { app } = mount();
    await started();
    send(callback(app), true);
    callRPCSpy.mockRejectedValueOnce(new Error("transport failure"));
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Stream" }),
    );
    expect(screen.getByText(/transport failure/)).toBeInTheDocument();
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
    send(callback(app), false);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Stream" }),
    );
    await screen.findByRole("button", { name: "Enable Stream" });
  });

  it("rejects old callbacks and RPC completion after replacing the connection", async () => {
    const pending = deferred();
    callRPCSpy.mockReturnValueOnce(pending.promise);
    const { app, rerender } = mount();
    await waitFor(() => expect(callRPCSpy).toHaveBeenCalled());
    const oldCallback = callback(app);
    const next = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    callRPCSpy.mockRejectedValueOnce(new Error("new connection failed"));
    rerender(
      <ZMKAppProvider value={next}>
        <InputStreamSection {...PROPS} />
      </ZMKAppProvider>,
    );
    await screen.findByText(/new connection failed/);
    await act(async () => pending.resolve(null));
    expect(
      screen.getByRole("button", { name: "Enable Stream" }),
    ).toBeInTheDocument();
    send(oldCallback, true);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Enable Stream" }),
    );
    await started();
    send(oldCallback, true);
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    send(callback(next), true, 1);
    expect(document.querySelectorAll(".keycap")[1]).toHaveClass(
      "keycap-pressed",
    );
  });

  it("rejects invalid layer indices with bounded rendering and recovers on valid events", async () => {
    const data = await mockCallRpc.getMockImplementation()!();
    let numericReads = 0;
    data.keymap.getKeymap.layers = new Proxy(data.keymap.getKeymap.layers, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          numericReads++;
          // Count the real production array accesses; stop an unsafe original
          // loop before it can perform billions of synchronous operations.
          if (numericReads > 128) throw new Error("layer scan budget exceeded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    mockCallRpc.mockResolvedValue(data);
    const { app } = mount();
    await started();
    const cb = callback(app);
    const layer = (layerIndex: number) => {
      const payload = Notification.encode(
        Notification.create({ layerChange: { layerIndex } }),
      ).finish();
      expect(Notification.decode(payload).layerChange?.layerIndex).toBe(
        layerIndex,
      );
      act(() => cb({ subsystemIndex: 0, payload }));
    };
    layer(1);
    expect(screen.getByText("Layer 1")).toBeInTheDocument();
    numericReads = 0;
    for (const invalid of [0xffffffff, 2]) {
      expect(() => layer(invalid)).not.toThrow();
      expect(screen.getByText("Layer 1")).toBeInTheDocument();
    }
    expect(numericReads).toBeLessThanOrEqual(128);
    layer(0);
    expect(screen.getByText("Layer 0")).toBeInTheDocument();
    send(cb, true);
    expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
  });

  it("retains a valid layer arriving synchronously before the enable acknowledgement", async () => {
    const app = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    const pending = deferred();
    callRPCSpy.mockImplementationOnce(() => {
      callback(app)({
        subsystemIndex: 0,
        payload: Notification.encode(
          Notification.create({ layerChange: { layerIndex: 1 } }),
        ).finish(),
      });
      return pending.promise;
    });
    mount(app);
    await waitFor(() => expect(callRPCSpy).toHaveBeenCalled());
    expect(screen.getByText("Layer 1")).toBeInTheDocument();
    await act(async () => pending.resolve(null));
    await started();
    expect(screen.getByText("Layer 1")).toBeInTheDocument();
  });
  it.each(["success", "error"])(
    "retires a pending enable %s when only the subsystem index changes",
    async (outcome) => {
      let index = 0;
      const app = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });
      app.findSubsystem = jest.fn(() => ({
        index,
        identifier: SUBSYSTEM_IDENTIFIER,
      }));
      const previous = deferred();
      const current = deferred();
      const indices: number[] = [];
      callRPCSpy.mockImplementation(function (this: ZMKCustomSubsystem) {
        const target = this.getSubsystemIndex();
        indices.push(target);
        return target === 0 ? previous.promise : current.promise;
      });
      const view = mount(app);
      await waitFor(() => expect(indices).toEqual([0]));
      const oldCallback = callback(app);
      const sameConnection = app.state.connection;
      index = 7;
      view.rerender(
        <ZMKAppProvider value={app}>
          <InputStreamSection {...PROPS} />
        </ZMKAppProvider>,
      );
      await waitFor(() => {
        const calls = (app.onNotification as jest.Mock).mock.calls.filter(
          ([sub]) => sub.type === "custom",
        );
        expect(calls[calls.length - 1][0].subsystemIndex).toBe(7);
      });
      await act(async () =>
        previous.resolve(
          outcome === "success"
            ? null
            : Response.encode(
                Response.create({
                  error: { message: "retired index refusal" },
                }),
              ).finish(),
        ),
      );
      send(oldCallback, true);
      expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
      expect(
        document.querySelector(".error-bar")?.textContent ?? "",
      ).not.toContain("retired index refusal");
      expect(
        screen.queryByRole("button", { name: "Disable Stream" }),
      ).not.toBeInTheDocument();
      expect(app.state.connection).toBe(sameConnection);
      await waitFor(() => expect(indices).toEqual([0, 7]));
      await act(async () => current.resolve(null));
      await started();
      send(oldCallback, true);
      expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
      view.unmount();
    },
  );
  it("accepts the loaded current catalog index and valid layer", async () => {
    const app = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    app.findSubsystem = jest.fn(() => ({
      index: 7,
      identifier: SUBSYSTEM_IDENTIFIER,
    }));
    const indices: number[] = [];
    callRPCSpy.mockImplementation(function (this: ZMKCustomSubsystem) {
      indices.push(this.getSubsystemIndex());
      return Promise.resolve(null);
    });
    mount(app);
    await started();
    expect(indices).toEqual([7]);
    act(() =>
      callback(app)({
        subsystemIndex: 7,
        payload: Notification.encode(
          Notification.create({ layerChange: { layerIndex: 1 } }),
        ).finish(),
      }),
    );
    expect(screen.getByText("Layer 1")).toBeInTheDocument();
  });

  it("retires an old metadata load when the same connection changes subsystem index", async () => {
    const data = await mockCallRpc.getMockImplementation()!();
    let resolve!: (value: typeof data) => void;
    const oldLayout = new Promise<typeof data>((done) => {
      resolve = done;
    });
    mockCallRpc.mockReturnValueOnce(oldLayout);
    let index = 0;
    const app = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    app.findSubsystem = jest.fn(() => ({
      index,
      identifier: SUBSYSTEM_IDENTIFIER,
    }));
    const indices: number[] = [];
    callRPCSpy.mockImplementation(function (this: ZMKCustomSubsystem) {
      indices.push(this.getSubsystemIndex());
      return Promise.resolve(null);
    });
    const view = mount(app);
    await waitFor(() => expect(mockCallRpc).toHaveBeenCalledTimes(3));
    index = 7;
    view.rerender(
      <ZMKAppProvider value={app}>
        <InputStreamSection {...PROPS} />
      </ZMKAppProvider>,
    );
    await waitFor(() => expect(mockCallRpc).toHaveBeenCalledTimes(6));
    await started();
    expect(indices).toEqual([7]);
    expect(document.querySelectorAll(".keycap")).toHaveLength(2);
    const stale = {
      ...data,
      keymap: {
        ...data.keymap,
        getPhysicalLayouts: {
          ...data.keymap.getPhysicalLayouts,
          layouts: [
            {
              ...data.keymap.getPhysicalLayouts.layouts[0],
              keys: data.keymap.getPhysicalLayouts.layouts[0].keys.slice(0, 1),
            },
          ],
        },
      },
    };
    await act(async () => resolve(stale));
    expect(document.querySelectorAll(".keycap")).toHaveLength(2);
    expect(indices).toEqual([7]);
  });

  it.each(["success", "error"])(
    "retires a pending disable %s after an index replacement enables the new stream",
    async (outcome) => {
      let index = 0;
      const app = createConnectedMockZMKApp({
        subsystems: [SUBSYSTEM_IDENTIFIER],
      });
      app.findSubsystem = jest.fn(() => ({
        index,
        identifier: SUBSYSTEM_IDENTIFIER,
      }));
      const view = mount(app);
      await started();
      const oldCallback = callback(app);
      const previous = deferred();
      const current = deferred();
      const indices: number[] = [];
      callRPCSpy.mockImplementation(function (this: ZMKCustomSubsystem) {
        const target = this.getSubsystemIndex();
        indices.push(target);
        return target === 0 ? previous.promise : current.promise;
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Disable Stream" }),
      );
      await waitFor(() => expect(indices).toEqual([0]));
      index = 7;
      view.rerender(
        <ZMKAppProvider value={app}>
          <InputStreamSection {...PROPS} />
        </ZMKAppProvider>,
      );
      await waitFor(() => expect(indices).toEqual([0, 7]));
      await act(async () => current.resolve(null));
      await started();
      act(() =>
        callback(app)({
          subsystemIndex: 7,
          payload: Notification.encode(
            Notification.create({
              keyEvent: {
                position: 0,
                pressed: true,
                behaviorId: 99,
                param1: 4,
                param2: 0,
              },
            }),
          ).finish(),
        }),
      );
      expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
      await act(async () =>
        previous.resolve(
          outcome === "success"
            ? null
            : Response.encode(
                Response.create({
                  error: { message: "retired disable refusal" },
                }),
              ).finish(),
        ),
      );
      expect(
        screen.getByRole("button", { name: "Disable Stream" }),
      ).toBeInTheDocument();
      expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
      expect(
        document.querySelector(".error-bar")?.textContent ?? "",
      ).not.toContain("retired disable refusal");
      send(oldCallback, false);
      expect(document.querySelector(".keycap")).toHaveClass("keycap-pressed");
    },
  );
});
