# ZMK Input Stream — Live Key Visualizer

## Reviewed fork

This fork's reviewed source is on `codex/input-stream-review` in
[`amgskobo/zmk-feature-input-stream`](https://github.com/amgskobo/zmk-feature-input-stream/tree/codex/input-stream-review).
Select that repository URL and revision in the module's west project entry.
Keep the module's documented imports enabled where required. The original
upstream installation examples below describe the upstream repository.

![ZMK Version](https://img.shields.io/badge/ZMK-master-blue)

A ZMK module that streams key press/release events and layer changes to a web UI for live visualization.

## Features

- **Live key streaming**: forwards physical key press/release events over the custom Studio RPC protocol with a bounded, best-effort queue
- **Layer tracking**: notifies the web UI whenever the active layer changes
- **Web visualizer**: renders the physical key layout, highlights pressed keys, plays a unique beep per key, and marks keys that have been pressed at least once
- **Behavior & keycode history**: shows a rolling log of firmware behavior events and browser key events

## Usage

### 1. Add the module to your ZMK config

In your `config/west.yml`:

```yaml
manifest:
  remotes:
    - name: zmkfirmware
      url-base: https://github.com/zmkfirmware
    - name: cormoran
      url-base: https://github.com/cormoran
  projects:
    - name: zmk
      remote: cormoran
      revision: main+custom-studio-protocol
      import: app/west.yml
    - name: zmk-feature-input-stream
      remote: cormoran
      revision: main
  self:
    path: config
```

### 2. Enable the feature in your keyboard config

In your keyboard's `.conf` file:

```
CONFIG_ZMK_INPUT_STREAM_FEATURE=y
CONFIG_ZMK_INPUT_STREAM_FEATURE_STUDIO_RPC=y

# Encoding nanopb requires more stack space
CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048
```

`CONFIG_ZMK_STUDIO=y` is also required (and the `studio-rpc-usb-uart` snippet or equivalent transport).

### 3. Bind the Studio unlock behavior

The input stream subsystem is **secured** — Studio must be unlocked before streaming can be enabled. Add `&studio_unlock` to a key in your keymap.

### 4. Open the web UI

Connect your keyboard via USB, open the web UI, click **Connect Serial**, unlock Studio, then click **Enable Stream**.

## Web UI layout

```
┌──────────────────────────────────────┐
│ • Streaming  Layer 0   [Enable Stream]│
├──────────────────────────────────────┤
│ Keyboard Layout                       │
│  ┌───┬───┬───┬───┐                   │
│  │ A │ B │ C │ D │  (pressed = blue) │
│  └───┴───┴───┴───┘                   │
│        ● = pressed at least once      │
├──────────────────────────────────────┤
│ Behavior Events   │ JS Key Events     │
│ #0  Key Press  A  │ A                 │
│ #0  Key Press  A  │ A                 │
└──────────────────────────────────────┘
```

## Development

```bash
# Run all lint + tests
pre-commit run

# Run firmware unit + build tests
python3 -m unittest discover -s tests -p test_owner.py

# Run web tests
cd web && npm test
```

## Delivery and lifecycle limits

The sender dispatches one notification per low-priority work invocation, then
resubmits at the queue tail. Disable discards queued notifications and rejects
producers from an earlier enable session; repeated enable is idempotent.
The sender resolves its fixed linker-registry index once after the first
successful lookup and reuses it for later notifications, including a later
enable session. A failed lookup is retried. This caches no authorization or
payload: the existing epoch and lock checks still run for every dispatch.
Lifecycle/queue locks are released before entering the Studio transport.
Studio locking or switching the selected endpoint also disables streaming and
purges queued data. Unlocking alone does not restart it: enable explicitly on
the authorized connection. Authorization is checked again before encoding a
selected payload on its first encoder pass, so waiting for the transport does
not preserve old access. A revoked payload is omitted from a valid envelope;
the encoder does not abort a frame that the core has already started.
The Web client listens to Studio's lock notification, clears held-key highlights
and rejects a pending enable acknowledgement from before that lock. Unlock does
not resume a previously revoked stream; click Enable Stream again.

The web client clears held-key highlights after a successful stop and ignores
notifications while disabled. Replacing the connection clears its view state;
old callbacks and unfinished RPC responses cannot reactivate the new view.
Events arriving before a successful enable acknowledgement are accepted, then
discarded if that enable fails. Disable errors leave the stream active for retry.
These rules cannot distinguish an old wire packet delivered after re-enable:
the unchanged protocol has no session identifier.

A selected dispatch may still block after disable, but its payload is rejected
before its first encoder pass. Nanopb's sizing and output passes share that
authorization decision, so a notification committed at sizing finishes even if
locking occurs before output. Later events are stopped. ZMK's synchronous
RPC sender has no cancellation/deadline API here. A transport stall can therefore
still hold the low-priority workqueue and RPC transport mutex. The work budget
does not guarantee progress while that call is blocked.

Queue overflow drops excess notifications. A lost release can leave the client
visualization pressed until a later matching event or client reset. The current
schema has no state snapshot, sequence or session identifier, so reconnect and
loss recovery are not guaranteed. These are Studio visualization notifications,
not the keyboard's HID key delivery path.

The owner [sender boundary test](tests/sender/README.md) uses real kernel work
and queues with a controlled send boundary; the normal unittest command includes
it alongside existing registration and board build fixtures. Actual USB/BLE
congestion, disconnect and reconnect require production-device verification.
