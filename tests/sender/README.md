# Notification sender boundaries

Run `bash tests/sender/run.sh` in the resolved owner west workspace. The normal
`python3 -m unittest discover -v -s tests -p test_owner.py` command includes it. One small native_sim binary
compiles the complete production handler, module schema, real
nanopb, Zephyr message queue/spinlock/work and ZMK low-priority queue/event
manager. Only the Studio registry/envelope/transport and keymap lookup are
controlled boundaries. This does not emulate USB, BLE or the physical board.

The fixture disables CMake's west module discovery with `WEST=OFF` and an empty
`ZEPHYR_MODULES`. Its production sources and nanopb are supplied explicitly.
An empty module list alone lets Zephyr discover the containing workspace and
load unrelated application Kconfig files into this standalone kernel fixture.

Seventeen scenarios run in fresh processes three times each; all fourteen
original scenarios remain:

- `control`: disabled filtering, repeated enable without losing queued data,
  exact key/layer order, binding IDs/uint32 values, null binding, malformed and
  empty requests, correct response after an error and subsequent event delivery.
- `stop`, `restart`: clear queued data and retain only new-session events.
- `race`: a producer paused during binding lookup cannot enqueue into a later
  enable session. The real kernel thread joins after a semaphore-defined race.
- `full`: retain the first four queued reports without blocking the producer,
  drop excess according to the current schema and deliver a subsequent event.
  A dropped release remains lost: this test records that limitation, not a claim
  of complete delivery or state recovery.
- `fair`: a peer work queued while a send is paused runs after that dispatch and
  before the next queued report. Per-report values/order are asserted.
- `missing`: missing subsystem registry and recovery without stale data.
  A failed lookup stays retryable; a later successful lookup is reused.
- `lookup`: only the first successful notification scans the immutable linker
  registry. Later notifications and a new enable session use the same index;
  disabled and locked producers still emit nothing. The controlled registry
  counts actual section visits, while exact decoded payload/order stay checked.
- `blocking`: disable returns while a selected dispatch is stalled. Queued
  reports and the selected payload are discarded before encoding. Other work
  cannot run until the controlled send returns.
- `locked`: reject enable while Studio is locked; unlocking alone does not
  restart streaming. Explicit enable resumes ordered delivery.
- `lock-race`: a producer paused during binding lookup cannot enqueue after
  authorization is revoked, including after a subsequent unlock/enable.
- `lock-dispatch`: locking while a selected dispatch waits discards its payload
  at encoding and purges queued reports; a later enable sends only new events.
- `encoding`: locking after the first nanopb sizing pass completes the already
  committed notification with the same payload, then blocks subsequent events.
- `endpoint`: switching the selected endpoint purges and disables streaming;
  explicit enable is required to resume it.
- `lease-expiry`: the real timer revokes authorization and purges queued data
  while the worker queue cannot progress. Late/missing/stale renewal tokens
  cannot start a new stream after cleanup or renew a replacement stream.
- `lease-renewal`: an identical current-epoch renewal extends the deadline
  without changing the epoch, then no further renewal expires normally.
- `layer-order`: the initial response and layer notifications use current
  indices for reordered stable IDs, exclude active layers below the default,
  and report a middle-layer change without changing the highest index.

Semaphore gates use bounded waits; failed checks exit nonzero. Raw dispatch and
peer timestamps/order are preserved. `INPUT_STREAM_NATIVE_ARTIFACTS` retains
binary/config/build/per-run logs; existing status files are not overwritten.
`INPUT_STREAM_SOURCE` can select an isolated baseline source for a negative
control. The fixture does not rewrite production or dependency source.

Authorization is checked at selection and on the first payload encoder pass
after any transport wait. That decision stays fixed across nanopb's sizing and
output passes. Revocation before that pass omits the bytes field successfully;
it does not fail an envelope after the core has started its frame. The fixture
sizes, encodes and decodes a nested protobuf envelope and requires matching
lengths even when the payload is omitted. A notification already committed at
the first sizing pass finishes; subsequent events are stopped. The module
cannot abort ZMK's synchronous RPC transport call. Its one-dispatch
work budget provides fairness once a call returns, not a bound on send latency.
Notification packets have no held-key snapshot/sequence/epoch, so complete loss recovery
or identifying a previous in-flight packet after reconnect needs a separately
defined protocol/client contract. Physical transport acceptance remains open.
