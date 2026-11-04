# Input Stream client

This React client visualizes key press/release events and active-layer changes
from the `zmk__input_stream` custom Studio subsystem. It offers Serial and BLE
connections and reads the keyboard's physical layout and behavior metadata.
Use Studio unlock before requesting protected data.

Starting a stream subscribes to notifications before sending the enable request,
so early notifications are retained. A failed start drops them. A successful stop
clears displayed held keys; results from a replaced connection cannot update the
current screen. A Studio lock clears held keys and cancels pending enable
acknowledgements. Unlock alone does not restart a revoked stream; enable it
explicitly. The firmware also stops the stream when the keyboard's output
switches (USB or BLE), and nothing tells the client: the button still reads
Disable Stream while no events arrive. Click it, then Enable Stream, to resume.
The Disconnect button sends Disable Stream before invoking the connection
abort. A 15-second firmware lease (configurable 10–120 seconds) also stops a
stream when a tab or process disappears. The current viewer renews every two
seconds using the nonzero epoch from enable and `renew_only=true`; an expired
or stale renewal never starts a session. Older viewers must add this renewal
or their streams expire; older firmware does not supply the lease guarantee.
Disable errors leave a retry action while renewal stops. Pending renewal
responses cannot update the view after stop, lock or session replacement.

The firmware can discard reports when its queue is full; it checks
authorization again before encoding a selected payload. Bytes already encoded
or handed to the transport cannot be recalled. The schema has no
held-key snapshot, sequence or notification epoch, so loss recovery and complete physical
transport delivery are not guaranteed.

Layer notifications must identify a loaded keymap layer. Invalid indices are
ignored, and transparent-binding fallback examines at most the loaded layer
count. A valid 32-bit active-layer mask uses current indices, respecting
reordered stable IDs and the default-layer cutoff. The initial/renewal response
provides the same snapshot. Without that information, labels stay blank until
the top layer is known; an older mask-less notification permits only its direct
nontransparent binding, with transparent fallback left unknown.
Loaded metadata is published before the enable request, so valid layer
events arriving before its acknowledgement are retained.

Failed enables restore the previously confirmed history, ever-pressed marks
and known layer state as well as clearing held highlights. This rolls back
provisional visualization without deleting confirmed results from a prior stream.

The connection and custom subsystem index identify one client session. Replacing
either clears its view and reloads metadata before starting the current stream.
Old load, enable/disable replies and notification callbacks cannot update the
replacement view. Requests already sent can still complete on the device.

Run from this directory:

```bash
npm ci
npm test -- --runInBand
npm run lint
npm run build
```

`npm run dev` starts local development. Tests, watch/coverage modes, development
and builds generate the TypeScript types from
`../proto/zmk/input_stream/input_stream.proto` with `buf generate`. Generated
files under `src/proto/` are ignored; do not edit or commit them by hand.

The client uses the package-lock-resolved Studio hook and transport libraries.
Tests exercise connection/stream lifecycle with controlled transports. The
[sender fixture](../tests/sender/README.md) covers the firmware's kernel boundary;
actual Serial/BLE delivery and input under load need hardware checks.

See the [module guide](../README.md) for firmware configuration.

## Console privacy

The local Vite plugin replaces the two locked Studio SDKs' exception log
arguments with fixed error categories. Messages, stacks, causes, device/profile
names and arbitrary error names are not SDK console arguments. New SDK console
sites stop the build for privacy review. Excluding the SDKs from development
prebundling applies the same transform in development and production. Transport,
exception propagation and visible UI messages are preserved. Browser/framework
diagnostics and unrelated browser extensions remain separate domains.

## Dependency security

`package.json` overrides the Studio client's transitive `protobufjs` dependency
to `7.6.5`, including the patched UTF-8 helper. Use `npm ci` with this lockfile.
After changing dependencies, run `npm audit --omit=dev`, the Web tests and the
production build.
