import { useCallback, useContext, useEffect, useRef, useState } from "react";
import "./App.css";
import { connect as serial_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { connect as gatt_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/gatt";
import { call_rpc, MetaError } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import type {
  Keymap,
  PhysicalLayouts,
  KeyPhysicalAttrs,
  BehaviorBinding,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type { CustomNotification } from "@zmkfirmware/zmk-studio-ts-client/custom";
import {
  ZMKConnection,
  ZMKCustomSubsystem,
  ZMKAppContext,
} from "@cormoran/zmk-studio-react-hook";
import {
  Request,
  Response,
  Notification,
} from "./proto/zmk/input_stream/input_stream";
import {
  getEffectiveBinding,
  isValidActiveLayerMask,
  isValidLayerIndex,
} from "./bindings";

export const SUBSYSTEM_IDENTIFIER = "zmk__input_stream";

// ─── HID keyboard usage → display label ───────────────────────────────────
const HID_KEY_NAMES: Record<number, string> = {
  0x04: "A",
  0x05: "B",
  0x06: "C",
  0x07: "D",
  0x08: "E",
  0x09: "F",
  0x0a: "G",
  0x0b: "H",
  0x0c: "I",
  0x0d: "J",
  0x0e: "K",
  0x0f: "L",
  0x10: "M",
  0x11: "N",
  0x12: "O",
  0x13: "P",
  0x14: "Q",
  0x15: "R",
  0x16: "S",
  0x17: "T",
  0x18: "U",
  0x19: "V",
  0x1a: "W",
  0x1b: "X",
  0x1c: "Y",
  0x1d: "Z",
  0x1e: "1",
  0x1f: "2",
  0x20: "3",
  0x21: "4",
  0x22: "5",
  0x23: "6",
  0x24: "7",
  0x25: "8",
  0x26: "9",
  0x27: "0",
  0x28: "Ent",
  0x29: "Esc",
  0x2a: "Bsp",
  0x2b: "Tab",
  0x2c: "Spc",
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
  0x39: "Caps",
  0x3a: "F1",
  0x3b: "F2",
  0x3c: "F3",
  0x3d: "F4",
  0x3e: "F5",
  0x3f: "F6",
  0x40: "F7",
  0x41: "F8",
  0x42: "F9",
  0x43: "F10",
  0x44: "F11",
  0x45: "F12",
  0x46: "PrtSc",
  0x47: "ScrLk",
  0x48: "Pause",
  0x49: "Ins",
  0x4a: "Home",
  0x4b: "PgUp",
  0x4c: "Del",
  0x4d: "End",
  0x4e: "PgDn",
  0x4f: "→",
  0x50: "←",
  0x51: "↓",
  0x52: "↑",
  0xe0: "LCtl",
  0xe1: "LSft",
  0xe2: "LAlt",
  0xe3: "LGui",
  0xe4: "RCtl",
  0xe5: "RSft",
  0xe6: "RAlt",
  0xe7: "RGui",
};

function hidUsageToLabel(usage: number): string {
  const page = (usage >>> 16) & 0xff;
  const id = usage & 0xffff;
  if (page === 0x07 || page === 0x00)
    return HID_KEY_NAMES[id] ?? `K${id.toString(16).toUpperCase()}`;
  if (page === 0x0c) return `M${id.toString(16).toUpperCase()}`;
  return `0x${usage.toString(16).toUpperCase()}`;
}

// ─── &trans helpers ────────────────────────────────────────────────────────
function isKpBehavior(det: GetBehaviorDetailsResponse): boolean {
  const n = det.displayName.toLowerCase();
  return n === "key press" || n === "kp";
}

// ─── Error helpers ────────────────────────────────────────────────────────
function friendlyError(e: unknown): string {
  if (
    e instanceof MetaError &&
    e.condition === ErrorConditions.UNLOCK_REQUIRED
  ) {
    return "Studio is locked — bind &studio_unlock to a key to enable streaming";
  }
  return e instanceof Error ? e.message : "Unknown error";
}

// ─── Audio ────────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;

function playBeep(position: number) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const freq = 261.63 * Math.pow(2, (position % 24) / 12);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.08);
  } catch {
    // audio unavailable
  }
}

// ─── Types ────────────────────────────────────────────────────────────────
interface BehaviorEvent {
  position: number;
  behaviorId: number;
  behaviorName: string;
  param1: number;
}

// ─── App ──────────────────────────────────────────────────────────────────
function App() {
  return (
    <div className="app">
      <ZMKConnection
        renderDisconnected={({ connect, isLoading, error }) => (
          <div className="status-bar disconnected">
            <span className="app-title">ZMK Input Stream</span>
            {error && <span className="status-error">{error}</span>}
            {isLoading ? (
              <span className="status-hint">Connecting…</span>
            ) : (
              <div className="connect-btns">
                <button
                  className="btn btn-primary"
                  onClick={() => connect(serial_connect)}
                >
                  Serial
                </button>
                <button
                  className="btn btn-ble"
                  onClick={() => connect(gatt_connect)}
                >
                  BLE
                </button>
              </div>
            )}
          </div>
        )}
        renderConnected={({ disconnect, deviceName }) => (
          <InputStreamSection
            deviceName={deviceName ?? ""}
            disconnect={disconnect}
          />
        )}
      />
      <footer className="app-footer">
        <p>
          <strong>ZMK Input Stream</strong> — Live key visualizer
        </p>
      </footer>
    </div>
  );
}

// ─── InputStreamSection ───────────────────────────────────────────────────
interface InputStreamSectionProps {
  deviceName: string;
  disconnect: () => void;
}

export function InputStreamSection({
  deviceName,
  disconnect,
}: InputStreamSectionProps) {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;
  const subsystem = zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER) ?? null;
  const subsystemIndex = subsystem?.index ?? null;

  const [keymap, setKeymap] = useState<Keymap | null>(null);
  const [physicalLayouts, setPhysicalLayouts] =
    useState<PhysicalLayouts | null>(null);
  const [behaviorMap, setBehaviorMap] = useState<
    Map<number, GetBehaviorDetailsResponse>
  >(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [streamPending, setStreamPending] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState(0);
  const [activeLayerKnown, setActiveLayerKnown] = useState(false);
  const [activeLayerMask, setActiveLayerMask] = useState<number | null>(null);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [unlockPending, setUnlockPending] = useState(false);
  const [loadTrigger, setLoadTrigger] = useState(0);

  const [pressedKeys, setPressedKeys] = useState<Set<number>>(new Set());
  const [everPressedKeys, setEverPressedKeys] = useState<Set<number>>(
    new Set()
  );
  const [behaviorHistory, setBehaviorHistory] = useState<BehaviorEvent[]>([]);
  const [jsKeycodes, setJsKeycodes] = useState<string[]>([]);
  const [currentJsKey, setCurrentJsKey] = useState<string | null>(null);

  // Refs to hold latest values for event handlers and effects without re-subscribing
  const streamingEnabledRef = useRef(false);
  const keymapRef = useRef<Keymap | null>(null);
  const streamRequestRef = useRef(0);
  const layerRevisionRef = useRef(0);
  const streamLeaseRef = useRef<{ epoch: number; leaseMs: number } | null>(
    null
  );
  const visibleStreamRef = useRef({
    everPressedKeys,
    behaviorHistory,
    activeLayer,
    activeLayerKnown,
    activeLayerMask,
  });
  useEffect(() => {
    visibleStreamRef.current = {
      everPressedKeys,
      behaviorHistory,
      activeLayer,
      activeLayerKnown,
      activeLayerMask,
    };
  }, [
    everPressedKeys,
    behaviorHistory,
    activeLayer,
    activeLayerKnown,
    activeLayerMask,
  ]);
  const pendingStartRef = useRef<{
    before: typeof visibleStreamRef.current;
    layerReceived: boolean;
  } | null>(null);
  const rollbackPendingStart = useCallback(() => {
    const pending = pendingStartRef.current;
    if (!pending) return;
    pendingStartRef.current = null;
    layerRevisionRef.current++;
    setEverPressedKeys(pending.before.everPressedKeys);
    setBehaviorHistory(pending.before.behaviorHistory);
    setActiveLayer(pending.before.activeLayer);
    setActiveLayerKnown(pending.before.activeLayerKnown);
    setActiveLayerMask(pending.before.activeLayerMask);
  }, []);
  const applyLayerState = useCallback(
    (state: {
      layerIndex: number;
      activeLayerMask: number;
      activeLayerMaskValid: boolean;
    }) => {
      const layers = keymapRef.current?.layers;
      if (!layers || !isValidLayerIndex(state.layerIndex, layers.length))
        return;
      setActiveLayer(state.layerIndex);
      setActiveLayerKnown(true);
      setActiveLayerMask(
        state.activeLayerMaskValid &&
          isValidActiveLayerMask(
            state.activeLayerMask,
            state.layerIndex,
            layers.length
          )
          ? state.activeLayerMask
          : null
      );
    },
    []
  );
  const streamLifetimeRef = useRef({
    active: false,
    connection,
    subsystemIndex,
  });
  const [viewSession, setViewSession] = useState({
    connection,
    subsystemIndex,
  });
  const enableStreamRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // The subsystem catalog can replace an index without replacing its connection.
  if (
    viewSession.connection !== connection ||
    viewSession.subsystemIndex !== subsystemIndex
  ) {
    setViewSession({ connection, subsystemIndex });
    setKeymap(null);
    setPhysicalLayouts(null);
    setBehaviorMap(new Map());
    setLoadError(null);
    setIsLoading(false);
    setUnlockPending(false);
    setStreamingEnabled(false);
    setStreamPending(false);
    setPressedKeys(new Set());
    setEverPressedKeys(new Set());
    setBehaviorHistory([]);
    setActiveLayer(0);
    setActiveLayerKnown(false);
    setActiveLayerMask(null);
    setDisconnectPending(false);
    setStreamError(null);
  }
  useEffect(() => {
    streamRequestRef.current++;
    streamingEnabledRef.current = false;
    streamLeaseRef.current = null;
    pendingStartRef.current = null;
    layerRevisionRef.current = 0;
    keymapRef.current = null;
    const lifetime = { active: true, connection, subsystemIndex };
    streamLifetimeRef.current = lifetime;
    return () => {
      lifetime.active = false;
      if (streamLifetimeRef.current === lifetime) streamLeaseRef.current = null;
    };
  }, [connection, subsystemIndex]);
  // Firmware revokes the stream on Studio lock. Invalidate pending enables as
  // well as notifications; an unlock notification must not restart it.
  useEffect(() => {
    if (!zmkApp || !connection) return;
    let subscribed = true;
    const unsubscribe = zmkApp.onNotification({
      type: "core",
      callback: (notification) => {
        if (
          !subscribed ||
          notification.lockStateChanged !==
            LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED
        )
          return;
        rollbackPendingStart();
        streamRequestRef.current++;
        streamLeaseRef.current = null;
        streamingEnabledRef.current = false;
        setStreamingEnabled(false);
        setStreamPending(false);
        setPressedKeys(new Set());
        setStreamError(
          "Studio is locked — unlock, then enable streaming again"
        );
      },
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [zmkApp, connection, subsystemIndex, rollbackPendingStart]);

  // Send disableStream on page close (best-effort)
  useEffect(() => {
    const handler = () => {
      const lifetime = streamLifetimeRef.current;
      if (
        !lifetime.active ||
        !streamingEnabledRef.current ||
        !lifetime.connection ||
        lifetime.subsystemIndex === null
      )
        return;
      const service = new ZMKCustomSubsystem(
        lifetime.connection,
        lifetime.subsystemIndex
      );
      const payload = Request.encode(
        Request.create({ disableStream: {} })
      ).finish();
      void service.callRPC(payload).catch(() => undefined);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Load keymap + behaviors on connect, then auto-start streaming.
  // Retried automatically when unlockPending via loadTrigger.
  useEffect(() => {
    if (!connection || subsystemIndex === null) return;
    let cancelled = false;
    const authorizationGeneration = streamRequestRef.current;
    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const [layoutResp, keymapResp, behaviorListResp] = await Promise.all([
          call_rpc(connection, { keymap: { getPhysicalLayouts: true } }),
          call_rpc(connection, { keymap: { getKeymap: true } }),
          call_rpc(connection, { behaviors: { listAllBehaviors: true } }),
        ]);
        if (cancelled) return;
        if (layoutResp.keymap?.getPhysicalLayouts)
          setPhysicalLayouts(layoutResp.keymap.getPhysicalLayouts);
        const loadedKeymap = keymapResp.keymap?.getKeymap;
        if (loadedKeymap) {
          // Publish metadata before enable can synchronously deliver its first
          // notification, including before React commits the state update.
          keymapRef.current = loadedKeymap;
          setKeymap(loadedKeymap);
          setActiveLayer((current) =>
            isValidLayerIndex(current, loadedKeymap.layers.length) ? current : 0
          );
        }

        const ids =
          behaviorListResp.behaviors?.listAllBehaviors?.behaviors ?? [];
        const detailResults = await Promise.all(
          ids.map((id) =>
            call_rpc(connection, {
              behaviors: { getBehaviorDetails: { behaviorId: id } },
            })
          )
        );
        if (cancelled) return;
        const bMap = new Map<number, GetBehaviorDetailsResponse>();
        for (const r of detailResults) {
          const d = r.behaviors?.getBehaviorDetails;
          if (d) bMap.set(d.id, d);
        }
        setUnlockPending(false);
        setBehaviorMap(bMap);
        if (!cancelled && authorizationGeneration === streamRequestRef.current)
          void enableStreamRef.current();
      } catch (e) {
        if (cancelled) return;
        if (
          e instanceof MetaError &&
          e.condition === ErrorConditions.UNLOCK_REQUIRED
        ) {
          setUnlockPending(true);
        } else {
          setUnlockPending(false);
          setLoadError(friendlyError(e));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, subsystemIndex, loadTrigger]);

  // Subscribe to notifications from firmware
  useEffect(() => {
    if (!zmkApp || subsystemIndex === null) return;
    let subscribed = true;
    const unsubscribe = zmkApp.onNotification({
      type: "custom",
      subsystemIndex,
      callback: (notif: CustomNotification) => {
        if (
          !subscribed ||
          !streamingEnabledRef.current ||
          notif.subsystemIndex !== subsystemIndex
        )
          return;
        try {
          const decoded = Notification.decode(notif.payload);
          if (decoded.keyEvent) {
            const { position, pressed, behaviorId, param1 } = decoded.keyEvent;
            if (pressed) playBeep(position);
            setPressedKeys((prev) => {
              const next = new Set(prev);
              if (pressed) next.add(position);
              else next.delete(position);
              return next;
            });
            if (pressed) {
              setEverPressedKeys((prev) => new Set([...prev, position]));
              setBehaviorHistory((prev) => {
                const det = behaviorMap.get(behaviorId);
                const entry: BehaviorEvent = {
                  position,
                  behaviorId,
                  behaviorName: det?.displayName ?? `#${behaviorId}`,
                  param1,
                };
                return [entry, ...prev].slice(0, 20);
              });
            }
          }
          if (decoded.layerChange) {
            const layerIndex = decoded.layerChange.layerIndex;
            const layers = keymapRef.current?.layers;
            if (layers && isValidLayerIndex(layerIndex, layers.length)) {
              layerRevisionRef.current++;
              if (pendingStartRef.current)
                pendingStartRef.current.layerReceived = true;
              applyLayerState(decoded.layerChange);
            }
          }
        } catch {
          // ignore decode errors
        }
      },
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [zmkApp, subsystemIndex, behaviorMap, applyLayerState]);

  // Capture JS key events
  useEffect(() => {
    const held = new Set<string>();
    const onDown = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (held.has(k)) return;
      held.add(k);
      setCurrentJsKey(k);
      setJsKeycodes((prev) => [k, ...prev].slice(0, 20));
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      held.delete(k);
      setCurrentJsKey((cur) => (cur === k ? null : cur));
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // Enable streaming after data loads
  const enableStream = useCallback(async () => {
    const lifetime = streamLifetimeRef.current;
    if (
      !connection ||
      subsystemIndex === null ||
      !lifetime.active ||
      lifetime.connection !== connection ||
      lifetime.subsystemIndex !== subsystemIndex
    )
      return;
    const requestId = ++streamRequestRef.current;
    streamLeaseRef.current = null;
    pendingStartRef.current = {
      before: visibleStreamRef.current,
      layerReceived: false,
    };
    // Firmware may emit events before the enable response reaches the browser.
    streamingEnabledRef.current = true;
    setStreamPending(true);
    setStreamError(null);
    try {
      const service = new ZMKCustomSubsystem(connection, subsystemIndex);
      const payload = Request.encode(
        Request.create({ enableStream: {} })
      ).finish();
      const respPayload = await service.callRPC(payload);
      if (
        !lifetime.active ||
        lifetime !== streamLifetimeRef.current ||
        requestId !== streamRequestRef.current
      )
        return;
      if (respPayload) {
        const resp = Response.decode(respPayload);
        if (resp.error) {
          streamingEnabledRef.current = false;
          setStreamingEnabled(false);
          setPressedKeys(new Set());
          rollbackPendingStart();
          setStreamError(resp.error.message);
          return;
        }
        if (resp.ok?.leaseMs && !resp.ok.streamEpoch)
          throw new Error("Stream lease expired before enable acknowledgement");
        if (resp.ok?.streamEpoch && resp.ok.leaseMs) {
          streamLeaseRef.current = {
            epoch: resp.ok.streamEpoch,
            leaseMs: resp.ok.leaseMs,
          };
        }
        if (resp.ok?.layerState && !pendingStartRef.current?.layerReceived)
          applyLayerState(resp.ok.layerState);
      }
      pendingStartRef.current = null;
      setStreamingEnabled(true);
    } catch (e) {
      if (
        !lifetime.active ||
        lifetime !== streamLifetimeRef.current ||
        requestId !== streamRequestRef.current
      )
        return;
      streamingEnabledRef.current = false;
      setStreamingEnabled(false);
      streamLeaseRef.current = null;
      setPressedKeys(new Set());
      rollbackPendingStart();
      setStreamError(friendlyError(e));
    } finally {
      if (
        lifetime.active &&
        lifetime === streamLifetimeRef.current &&
        requestId === streamRequestRef.current
      )
        setStreamPending(false);
    }
  }, [connection, subsystemIndex, rollbackPendingStart, applyLayerState]);

  // Keep ref in sync so the load effect can call the latest enableStream
  useEffect(() => {
    enableStreamRef.current = enableStream;
  }, [enableStream]);

  // Retry loading every 2 s while Studio is locked
  useEffect(() => {
    if (!unlockPending || !connection) return;
    const id = setInterval(() => setLoadTrigger((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, [unlockPending, connection, subsystemIndex]);

  // Stream toggle button handler
  const toggleStreaming = useCallback(async () => {
    const lifetime = streamLifetimeRef.current;
    if (
      !connection ||
      subsystemIndex === null ||
      !lifetime.active ||
      lifetime.connection !== connection ||
      lifetime.subsystemIndex !== subsystemIndex
    )
      return;
    if (streamingEnabled) {
      const requestId = ++streamRequestRef.current;
      streamLeaseRef.current = null;
      setStreamPending(true);
      setStreamError(null);
      try {
        const service = new ZMKCustomSubsystem(connection, subsystemIndex);
        const payload = Request.encode(
          Request.create({ disableStream: {} })
        ).finish();
        const respPayload = await service.callRPC(payload);
        if (
          !lifetime.active ||
          lifetime !== streamLifetimeRef.current ||
          requestId !== streamRequestRef.current
        )
          return;
        if (respPayload) {
          const resp = Response.decode(respPayload);
          if (resp.error) {
            setStreamError(resp.error.message);
            return;
          }
        }
        streamingEnabledRef.current = false;
        setStreamingEnabled(false);
        setPressedKeys(new Set());
      } catch (e) {
        if (
          !lifetime.active ||
          lifetime !== streamLifetimeRef.current ||
          requestId !== streamRequestRef.current
        )
          return;
        setStreamError(friendlyError(e));
      } finally {
        if (
          lifetime.active &&
          lifetime === streamLifetimeRef.current &&
          requestId === streamRequestRef.current
        )
          setStreamPending(false);
      }
    } else {
      await enableStream();
    }
  }, [connection, subsystemIndex, streamingEnabled, enableStream]);

  useEffect(() => {
    const lease = streamLeaseRef.current;
    const lifetime = streamLifetimeRef.current;
    if (
      !streamingEnabled ||
      !lease ||
      !lifetime.connection ||
      lifetime.subsystemIndex === null
    )
      return;
    const requestId = streamRequestRef.current;
    let retired = false;
    let pending = false;
    const isCurrent = () =>
      !retired &&
      lifetime.active &&
      lifetime === streamLifetimeRef.current &&
      requestId === streamRequestRef.current &&
      lease === streamLeaseRef.current;
    const timer = window.setInterval(() => {
      if (!isCurrent() || pending) return;
      pending = true;
      const layerRevision = layerRevisionRef.current;
      const service = new ZMKCustomSubsystem(
        lifetime.connection!,
        lifetime.subsystemIndex!
      );
      const payload = Request.encode(
        Request.create({
          enableStream: { renewOnly: true, streamEpoch: lease.epoch },
        })
      ).finish();
      void service
        .callRPC(payload)
        .then((bytes) => {
          if (!isCurrent()) return;
          if (!bytes) throw new Error("Stream renewal response missing");
          const response = Response.decode(bytes);
          if (response.error) throw new Error(response.error.message);
          if (!response.ok || response.ok.streamEpoch !== lease.epoch)
            throw new Error("Stream lease expired or changed");
          if (
            response.ok.layerState &&
            layerRevision === layerRevisionRef.current
          )
            applyLayerState(response.ok.layerState);
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          streamRequestRef.current++;
          streamLeaseRef.current = null;
          streamingEnabledRef.current = false;
          setStreamingEnabled(false);
          setPressedKeys(new Set());
          setStreamError(friendlyError(error));
        })
        .finally(() => {
          pending = false;
        });
    }, 2000);
    return () => {
      retired = true;
      window.clearInterval(timer);
    };
  }, [streamingEnabled, connection, subsystemIndex, applyLayerState]);

  const disconnectStream = useCallback(async () => {
    const lifetime = streamLifetimeRef.current;
    if (disconnectPending || !lifetime.active) return;
    streamRequestRef.current++;
    streamLeaseRef.current = null;
    streamingEnabledRef.current = false;
    rollbackPendingStart();
    setStreamingEnabled(false);
    setStreamPending(false);
    setPressedKeys(new Set());
    setDisconnectPending(true);
    try {
      if (lifetime.connection && lifetime.subsystemIndex !== null) {
        const service = new ZMKCustomSubsystem(
          lifetime.connection,
          lifetime.subsystemIndex
        );
        await service.callRPC(
          Request.encode(Request.create({ disableStream: {} })).finish()
        );
      }
    } catch {
      // Abort still completes; the firmware lease bounds a lost stop request.
    } finally {
      if (lifetime.active && lifetime === streamLifetimeRef.current) {
        lifetime.active = false;
        disconnect();
      }
    }
  }, [disconnect, disconnectPending, rollbackPendingStart]);

  if (!zmkApp) return null;

  const layout =
    physicalLayouts?.layouts[physicalLayouts.activeLayoutIndex] ?? null;

  return (
    <>
      {/* ── Compact status bar ── */}
      <div className="status-bar connected">
        <span
          className={`stream-dot ${streamingEnabled ? "on" : ""}`}
          title={streamingEnabled ? "Streaming" : "Stream off"}
        />
        <span className="status-device">{deviceName}</span>
        <span className="layer-badge">
          Layer {activeLayerKnown ? activeLayer : "?"}
        </span>
        {isLoading && <span className="status-hint">Loading…</span>}
        {subsystem ? (
          <button
            className={`btn btn-sm ${streamingEnabled ? "btn-danger" : "btn-primary"}`}
            onClick={toggleStreaming}
            disabled={unlockPending || streamPending || disconnectPending}
          >
            {streamingEnabled ? "Disable Stream" : "Enable Stream"}
          </button>
        ) : (
          <span
            className="status-warn"
            title={`Subsystem "${SUBSYSTEM_IDENTIFIER}" not found`}
          >
            No subsystem
          </span>
        )}
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => void disconnectStream()}
          disabled={disconnectPending}
          title="Disconnect"
        >
          ×
        </button>
      </div>

      {/* ── Unlock pending info ── */}
      {unlockPending && (
        <div className="info-bar">
          <span>
            Studio is locked — press &amp;studio_unlock key to load keyboard
            data (retrying…)
          </span>
          <button
            className="info-bar-dismiss"
            onClick={() => {
              setUnlockPending(false);
              setLoadError(
                "Studio is locked — press &studio_unlock then reconnect"
              );
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Error display ── */}
      {(streamError || loadError) && (
        <div className="error-bar">
          <span>⚠ {streamError ?? loadError}</span>
          <button
            className="error-bar-dismiss"
            onClick={() => {
              setStreamError(null);
              setLoadError(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Keyboard layout ── */}
      {layout && keymap && (
        <section className="card layout-card">
          <KeyboardLayoutView
            layout={layout}
            keymap={keymap}
            activeLayer={activeLayer}
            activeLayerKnown={activeLayerKnown}
            activeLayerMask={activeLayerMask}
            behaviorMap={behaviorMap}
            pressedKeys={pressedKeys}
            everPressedKeys={everPressedKeys}
          />
        </section>
      )}

      {/* ── History panels ── */}
      <section className="card">
        <div className="history-panels">
          <BehaviorHistoryPanel
            history={behaviorHistory}
            behaviorMap={behaviorMap}
          />
          <JsKeycodePanel current={currentJsKey} history={jsKeycodes} />
        </div>
      </section>
    </>
  );
}

// ─── Layout bounds (rotation-aware) ───────────────────────────────────────
function layoutBounds(keys: KeyPhysicalAttrs[]): {
  maxX: number;
  maxY: number;
} {
  let maxX = 0,
    maxY = 0;
  for (const k of keys) {
    if (k.r === 0) {
      maxX = Math.max(maxX, k.x + k.width);
      maxY = Math.max(maxY, k.y + k.height);
    } else {
      const rad = (k.r / 100) * (Math.PI / 180);
      const cos = Math.cos(rad),
        sin = Math.sin(rad);
      const corners = [
        [k.x, k.y],
        [k.x + k.width, k.y],
        [k.x + k.width, k.y + k.height],
        [k.x, k.y + k.height],
      ];
      for (const [cx, cy] of corners) {
        const dx = cx - k.rx,
          dy = cy - k.ry;
        maxX = Math.max(maxX, k.rx + dx * cos - dy * sin);
        maxY = Math.max(maxY, k.ry + dx * sin + dy * cos);
      }
    }
  }
  return { maxX, maxY };
}

const LAYOUT_MAX_PX = 820; // target width in px (accounts for card padding)
const SCALE_MIN = 0.28;
const SCALE_MAX = 0.65;

// ─── Keyboard layout view ─────────────────────────────────────────────────
interface KeyboardLayoutViewProps {
  layout: PhysicalLayouts["layouts"][number];
  keymap: Keymap;
  activeLayer: number;
  activeLayerKnown: boolean;
  activeLayerMask: number | null;
  behaviorMap: Map<number, GetBehaviorDetailsResponse>;
  pressedKeys: Set<number>;
  everPressedKeys: Set<number>;
}

function KeyboardLayoutView({
  layout,
  keymap,
  activeLayer,
  activeLayerKnown,
  activeLayerMask,
  behaviorMap,
  pressedKeys,
  everPressedKeys,
}: KeyboardLayoutViewProps) {
  const { maxX, maxY } = layoutBounds(layout.keys);
  const scale =
    maxX > 0
      ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, LAYOUT_MAX_PX / maxX))
      : 0.48;

  return (
    <div
      className="keyboard-layout"
      style={{
        width: Math.ceil(maxX * scale) + 2,
        height: Math.ceil(maxY * scale) + 2,
      }}
    >
      {layout.keys.map((key, i) => {
        const binding = activeLayerKnown
          ? getEffectiveBinding(
              keymap,
              i,
              activeLayer,
              behaviorMap,
              activeLayerMask
            )
          : null;
        const label = binding ? getKpLabel(binding, behaviorMap) : "";
        return (
          <KeyCap
            key={i}
            keyAttrs={key}
            scale={scale}
            label={label}
            pressed={pressedKeys.has(i)}
            everPressed={everPressedKeys.has(i)}
          />
        );
      })}
    </div>
  );
}

function getKpLabel(
  binding: BehaviorBinding,
  behaviorMap: Map<number, GetBehaviorDetailsResponse>
): string {
  const det = behaviorMap.get(binding.behaviorId);
  if (!det || !isKpBehavior(det)) return "";
  return hidUsageToLabel(binding.param1);
}

interface KeyCapProps {
  keyAttrs: KeyPhysicalAttrs;
  scale: number;
  label: string;
  pressed: boolean;
  everPressed: boolean;
}

function KeyCap({ keyAttrs, scale, label, pressed, everPressed }: KeyCapProps) {
  const { x, y, width, height, r, rx, ry } = keyAttrs;
  const deg = r / 100;

  // transform-origin is relative to the key's top-left corner
  const originX = (rx - x) * scale;
  const originY = (ry - y) * scale;

  return (
    <div
      className={`keycap${pressed ? " keycap-pressed" : ""}${everPressed ? " keycap-ever-pressed" : ""}`}
      style={{
        left: x * scale,
        top: y * scale,
        width: width * scale,
        height: height * scale,
        ...(deg !== 0 && {
          transform: `rotate(${deg}deg)`,
          transformOrigin: `${originX}px ${originY}px`,
        }),
      }}
    >
      <span className="keycap-label">{label}</span>
      {everPressed && <span className="keycap-dot" />}
    </div>
  );
}

// ─── Behavior history panel ───────────────────────────────────────────────
function BehaviorHistoryPanel({
  history,
  behaviorMap,
}: {
  history: BehaviorEvent[];
  behaviorMap: Map<number, GetBehaviorDetailsResponse>;
}) {
  return (
    <div className="history-panel">
      <h3>Behavior Events</h3>
      {history.length === 0 ? (
        <p className="hint-text">No events yet</p>
      ) : (
        <ul className="history-list">
          {history.map((ev, i) => {
            const det = behaviorMap.get(ev.behaviorId);
            const paramStr =
              det && isKpBehavior(det) ? hidUsageToLabel(ev.param1) : "";
            return (
              <li key={i} className="history-item">
                <span className="history-pos">#{ev.position}</span>
                <span className="history-name">{ev.behaviorName}</span>
                {paramStr && <span className="history-param">{paramStr}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── JS keycode panel ─────────────────────────────────────────────────────
function JsKeycodePanel({
  current,
  history,
}: {
  current: string | null;
  history: string[];
}) {
  return (
    <div className="history-panel">
      <h3>JS Key Events</h3>
      <div
        className="current-key"
        style={{ visibility: current ? "visible" : "hidden" }}
      >
        {current ?? " "}
      </div>
      {history.length === 0 ? (
        <p className="hint-text">Press a key to capture</p>
      ) : (
        <ul className="history-list">
          {history.map((k, i) => (
            <li
              key={i}
              className={`history-item${i === 0 && current === k ? " history-item-active" : ""}`}
            >
              {k}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default App;
