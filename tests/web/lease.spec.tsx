import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { ZMKCustomSubsystem } from "@cormoran/zmk-studio-react-hook";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { InputStreamSection, SUBSYSTEM_IDENTIFIER } from "../../web/src/App";
import {
  Notification,
  Request,
  Response,
} from "../../web/src/proto/zmk/input_stream/input_stream";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn(),
  MetaError: class MetaError extends Error {
    condition = -1;
  },
}));

const layer = (layerIndex = 0, activeLayerMask = 1) => ({
  layerIndex,
  activeLayerMask,
  activeLayerMaskValid: true,
});
const ok = (epoch = 19, state = layer()) =>
  Response.encode(
    Response.create({
      ok: { streamEpoch: epoch, leaseMs: 15000, layerState: state },
    }),
  ).finish();

function metadata() {
  return {
    keymap: {
      getPhysicalLayouts: {
        activeLayoutIndex: 0,
        layouts: [
          {
            name: "Synthetic layout",
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
        layers: [5, 7, 2].map((id, index) => ({
          id,
          name: `L${index}`,
          bindings: [0, 1].map((position) => ({
            behaviorId: index === 2 ? 7 : 99,
            param1: index === 1 ? 0x3a + position : 4 + position,
            param2: 0,
          })),
        })),
      },
    },
    behaviors: { listAllBehaviors: { behaviors: [7, 99] } },
  };
}

function deferred() {
  let resolve!: (value: Uint8Array | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Uint8Array | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount(
  app = createConnectedMockZMKApp({ subsystems: [SUBSYSTEM_IDENTIFIER] }),
) {
  const disconnect = jest.fn();
  const view = render(
    <ZMKAppProvider value={app}>
      <InputStreamSection
        deviceName="Synthetic device"
        disconnect={disconnect}
      />
    </ZMKAppProvider>,
  );
  const emit = (message: Parameters<typeof Notification.create>[0]) => {
    const calls = (app.onNotification as jest.Mock).mock.calls;
    const subscriptions = calls.filter(
      ([subscription]) => subscription.type === "custom",
    );
    act(() =>
      subscriptions[subscriptions.length - 1][0].callback({
        subsystemIndex: 0,
        payload: Notification.encode(Notification.create(message)).finish(),
      }),
    );
  };
  return { ...view, app, disconnect, emit };
}

let rpc: jest.SpyInstance;
beforeEach(() => {
  (call_rpc as jest.Mock).mockImplementation((_connection, request) => {
    const id = request.behaviors?.getBehaviorDetails?.behaviorId;
    return Promise.resolve(
      id === undefined
        ? metadata()
        : {
            behaviors: {
              getBehaviorDetails: {
                id,
                displayName: id === 7 ? "Transparent" : "Key Press",
              },
            },
          },
    );
  });
  rpc = jest
    .spyOn(ZMKCustomSubsystem.prototype, "callRPC")
    .mockImplementation((bytes) => {
      const request = Request.decode(bytes);
      return Promise.resolve(ok(request.disableStream ? 0 : 19));
    });
});
afterEach(() => {
  rpc.mockRestore();
  jest.useRealTimers();
  jest.clearAllMocks();
});

it("renews only the owned epoch and stops renewal after unmount", async () => {
  jest.useFakeTimers();
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(Request.decode(rpc.mock.calls[1][0]).enableStream).toEqual({
    renewOnly: true,
    streamEpoch: 19,
  });
  view.unmount();
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("sends disable while the connection is alive before invoking disconnect", async () => {
  const stop = deferred();
  rpc.mockImplementation((bytes) =>
    Request.decode(bytes).disableStream ? stop.promise : Promise.resolve(ok()),
  );
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  fireEvent.click(screen.getByTitle("Disconnect"));
  await waitFor(() =>
    expect(
      Request.decode(rpc.mock.calls[rpc.mock.calls.length - 1][0])
        .disableStream,
    ).toBeDefined(),
  );
  expect(view.disconnect).not.toHaveBeenCalled();
  await act(async () => stop.resolve(ok(0)));
  expect(view.disconnect).toHaveBeenCalledTimes(1);
});

it("turns a rejected renewal off without an automatic fresh enable", async () => {
  jest.useFakeTimers();
  rpc.mockImplementation((bytes) =>
    Promise.resolve(
      Request.decode(bytes).enableStream?.renewOnly
        ? Response.encode(
            Response.create({ error: { message: "lease expired" } }),
          ).finish()
        : ok(),
    ),
  );
  mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(
    screen.getByRole("button", { name: "Enable Stream" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/lease expired/)).toBeInTheDocument();
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("ignores a late renewal response after stop, including its old layer snapshot", async () => {
  jest.useFakeTimers();
  const renewal = deferred();
  rpc.mockImplementation((bytes) =>
    Request.decode(bytes).enableStream?.renewOnly
      ? renewal.promise
      : Promise.resolve(ok()),
  );
  mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  fireEvent.click(screen.getByRole("button", { name: "Disable Stream" }));
  await screen.findByRole("button", { name: "Enable Stream" });
  await act(async () => renewal.resolve(ok(19, layer(2, 5))));
  expect(screen.getByText("Layer 0")).toBeInTheDocument();
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(rpc).toHaveBeenCalledTimes(3);
});

it("does not restore a stream when a renewal completes after lock and unlock", async () => {
  jest.useFakeTimers();
  const renewal = deferred();
  rpc.mockImplementation((bytes) =>
    Request.decode(bytes).enableStream?.renewOnly
      ? renewal.promise
      : Promise.resolve(ok()),
  );
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  const core = (view.app.onNotification as jest.Mock).mock.calls
    .filter(([subscription]) => subscription.type === "core")
    .at(-1)![0];
  act(() => {
    core.callback({
      lockStateChanged: LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED,
    });
    core.callback({
      lockStateChanged: LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED,
    });
  });
  await act(async () => renewal.resolve(ok()));
  expect(
    screen.getByRole("button", { name: "Enable Stream" }),
  ).toBeInTheDocument();
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it.each(["success", "error"])(
  "ignores a retired-index renewal %s after a replacement stream starts",
  async (outcome) => {
    jest.useFakeTimers();
    let index = 0;
    const app = createConnectedMockZMKApp({
      subsystems: [SUBSYSTEM_IDENTIFIER],
    });
    app.findSubsystem = jest.fn(() => ({
      index,
      identifier: SUBSYSTEM_IDENTIFIER,
    }));
    const renewal = deferred();
    rpc.mockImplementation(function (this: ZMKCustomSubsystem, bytes) {
      const request = Request.decode(bytes);
      return request.enableStream?.renewOnly && this.getSubsystemIndex() === 0
        ? renewal.promise
        : Promise.resolve(ok(this.getSubsystemIndex() === 0 ? 19 : 29));
    });
    const view = mount(app);
    await screen.findByRole("button", { name: "Disable Stream" });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    index = 7;
    view.rerender(
      <ZMKAppProvider value={app}>
        <InputStreamSection
          deviceName="Synthetic device"
          disconnect={view.disconnect}
        />
      </ZMKAppProvider>,
    );
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    await screen.findByRole("button", { name: "Disable Stream" });
    await act(async () =>
      renewal.resolve(
        outcome === "success"
          ? ok(19, layer(2, 5))
          : Response.encode(
              Response.create({ error: { message: "retired lease" } }),
            ).finish(),
      ),
    );
    expect(screen.getByText("Layer 0")).toBeInTheDocument();
    expect(screen.queryByText(/retired lease/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Disable Stream" }),
    ).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(Request.decode(rpc.mock.calls[3][0]).enableStream).toEqual({
      renewOnly: true,
      streamEpoch: 29,
    });
  },
);

it("retains a newer layer notification when a renewal snapshot arrives late", async () => {
  jest.useFakeTimers();
  const renewal = deferred();
  rpc.mockImplementation((bytes) =>
    Request.decode(bytes).enableStream?.renewOnly
      ? renewal.promise
      : Promise.resolve(ok()),
  );
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  view.emit({ layerChange: layer(2, 5) });
  await act(async () => renewal.resolve(ok(19, layer(0, 1))));
  expect(screen.getByText("Layer 2")).toBeInTheDocument();
});

it.each(["error", "rejection"])(
  "rolls back every provisional visualization after enable %s",
  async (outcome) => {
    const pending = deferred();
    rpc.mockReturnValueOnce(pending.promise);
    const view = mount();
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    view.emit({
      keyEvent: {
        position: 1,
        pressed: true,
        behaviorId: 99,
        param1: 5,
        param2: 0,
      },
    });
    view.emit({ layerChange: layer(2, 5) });
    expect(document.querySelectorAll(".keycap-ever-pressed")).toHaveLength(1);
    expect(document.querySelectorAll(".history-item")).toHaveLength(1);
    expect(screen.getByText("Layer 2")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "error")
        pending.resolve(
          Response.encode(
            Response.create({ error: { message: "denied" } }),
          ).finish(),
        );
      else pending.reject(new Error("denied"));
    });
    expect(document.querySelectorAll(".keycap-pressed")).toHaveLength(0);
    expect(document.querySelectorAll(".keycap-ever-pressed")).toHaveLength(0);
    expect(document.querySelectorAll(".history-item")).toHaveLength(0);
    expect(screen.getByText("Layer ?")).toBeInTheDocument();
  },
);

it("preserves confirmed history and marks when a later start fails", async () => {
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  view.emit({
    keyEvent: {
      position: 0,
      pressed: true,
      behaviorId: 99,
      param1: 4,
      param2: 0,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Disable Stream" }));
  await screen.findByRole("button", { name: "Enable Stream" });
  const pending = deferred();
  rpc.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Enable Stream" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  view.emit({
    keyEvent: {
      position: 1,
      pressed: true,
      behaviorId: 99,
      param1: 5,
      param2: 0,
    },
  });
  view.emit({ layerChange: layer(2, 5) });
  await act(async () =>
    pending.resolve(
      Response.encode(
        Response.create({ error: { message: "denied" } }),
      ).finish(),
    ),
  );
  expect(document.querySelectorAll(".history-item")).toHaveLength(1);
  expect(document.querySelector(".history-pos")?.textContent).toBe("#0");
  const keys = document.querySelectorAll(".keycap");
  expect(keys[0]).toHaveClass("keycap-ever-pressed");
  expect(keys[1]).not.toHaveClass("keycap-ever-pressed");
  expect(screen.getByText("Layer 0")).toBeInTheDocument();
});

it("uses active indices for transparent labels and leaves legacy fallback unknown", async () => {
  rpc.mockResolvedValueOnce(ok(19, layer(2, 5)));
  const view = mount();
  await screen.findByRole("button", { name: "Disable Stream" });
  const label = () => document.querySelector(".keycap-label")?.textContent;
  expect(label()).toBe("A");
  view.emit({ layerChange: layer(2, 7) });
  expect(label()).toBe("F1");
  view.emit({
    layerChange: {
      layerIndex: 2,
      activeLayerMask: 0,
      activeLayerMaskValid: false,
    },
  });
  expect(label()).toBe("");
  view.emit({ layerChange: layer(2, 0xffffffff) });
  expect(label()).toBe("");
});
