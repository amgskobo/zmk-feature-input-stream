# Owner tests

This repository owns its executable test logic and fixtures under `tests/`.

## Current test ownership and compatibility

This owner supports DYA custom Studio RPC. Stock ZMK is NOT APPLICABLE;
no feature-disabled stock check is required or counted as compatibility.

Canonical entries (run from the repository root):

```bash
python3 -m unittest discover -v -s tests -p test_owner.py
bash tests/run-web.sh
```

[maintenance.json](maintenance.json) records supported cores, current commands
and explicit gaps. It is a reference map, not a passing test or a claim that
registration/coverage totals establish completeness. Preserve ordered outputs,
raw timestamps and the first failure. Read actual dependencies before execution.

`OWNER_TEST_OUTPUT=/absolute/new/directory` retains owner native/build outputs.
An existing directory fails before tests. Without it a fresh temporary directory
is printed and retained. No shared build directory is deleted. Use
`PYTHONPATH=tests python3 -m unittest -v test_owner.WestCommandsTests.<method>`
for a focused case; discovery runs the complete documented class.

Web assertions and Jest configuration live in `tests/web/`; application source
and installed dependencies remain in `web/`. The package scripts only dispatch
the owner configuration. No dependencies are installed implicitly by the tests.

The native verifier runs each built binary three times in independent empty
initial-flash directories, retaining raw output before filtering. It checks real
process exits, fatal assertions and every linked checked-init result before
comparing unchanged owner snapshots. A SYS_INIT error cannot be hidden by a
later matching key trace. Native scheduling and controlled APIs still do not
establish physical transport/retention. Test-only core/tool dependencies are
pinned; update pins only after reviewing the new sources and rerunning this
owner matrix. No network updates are implicit in the owner test command.

## Reproducible isolated checks

Use this owner's `west/west-test-isolated.yml` and its pinned test dependency
manifest. Test ZMK is `e5c9b6915b56801193e359dd9bad4a167ce0d1b8`;
Zephyr is `10ba6d0cb38bc3d258775d27982f707599320085`. Resolve the
manifest and verify actual checkout identities before running. Do not inherit
global CMake module overrides or moving production dependency references into
these isolated fixtures. The CI SDK image is pinned by digest in
`.github/workflows/zmk-module.yml`; production dependency manifests are separate.

Use a new `OWNER_TEST_OUTPUT` directory for every complete owner run. Native
repeats reuse one compiled binary with independent initial-flash state; keep
the first failure and raw combined stdout/stderr order. DYA-only compatibility
still means no stock-ZMK test requirement.

The test/tool static CI job installs pre-commit 4.7.0 and uses the pinned
Ruff/clang-format/formatting hooks. Its SKIP list avoids repeating the firmware
and Web jobs. Local full pre-commit execution may run those functional hooks;
prepare Web dependencies with the normal package lifecycle first where present.
A successful hook exit must also leave source inputs unchanged. Snapshot and
event-pattern bytes are excluded from whitespace rewriting.

## Sender registry lookup

The canonical firmware entry retains all prior cases and runs seventeen sender
scenarios three times. `lookup` counts visits to the controlled registry while
the real sender dispatches ordered, decoded reports: after one successful scan,
later reports and enable sessions perform no further scan. `missing` verifies
that failure is retryable before a successful result is reused. The original
source fails these operation-count assertions three times; all prior lifecycle,
authorization, encoding and queue assertions remain. Registry lookup is fixed
for a boot and occurs only on the serialized low-priority sender. This is a
software operation count, not measured USB/BLE/HID latency or CPU time.

The owner command boundary limits `zmk-build` to one target at a time by
default. `OWNER_TEST_BUILD_PARALLELISM` selects an explicit positive target
count; account for compiler jobs and concurrent owners in the global budget.
`tests/test_build_budget.py` checks default/explicit forwarding and rejects
invalid budgets before launching west. The canonical owner entry includes
these controls without dropping any native or board scenario.

Native result admission requires every `native_sim.keymap` fixture to have a
matching binary. `required_hooks.json` names the expected checked initialization
hooks and required feature/role configuration. Fixture-bound declarations also
reject missing configuration when both the request and build omit it; excluded
roles cannot replace the requested role. The verifier retains all three raw
runs before comparing unchanged ordered snapshots and rejects logged failures,
fatal output and missing/nonzero completions. `tests/test_native_verifier.py`
owns eleven real-ELF admission controls, including a deliberately missing
native scenario, wrong-role and unrelated-fixture controls.

`bash tests/run-web.sh` is the canonical schema-generation/Web test entry.
It runs all configured Jest scenarios in one worker process. The pre-commit
Jest hook dispatches this same owner entry so nested workers do not multiply
the global container budget. Build and lint retain their separate package entries.

The Web layer-bound regressions use the actual App and protobuf notifications.
A guarded layer array counts existing rendering accesses and stops an unsafe
original scan before billions of operations. Invalid uint32 indices must leave
the last valid layer intact, followed by normal event recovery. A synchronous
first-layer event before the enable acknowledgement remains accepted.
`web/bindings.spec.ts` separately retains transparent fallback, empty/first/last
layers, stale indices and independent positions with a loaded-layer work bound.

The same App/codec fixture replaces only the provider's subsystem index while
retaining its connection. Pending enable/disable success and error replies, old
notifications and a deferred metadata load must retire; a current-index stream
still starts and accepts valid layers. This is client/provider replacement
coverage, not a claim that the firmware's boot registry changes dynamically.

## Lease and layer-state regressions

The sender suite retains all fourteen original scenarios and adds
`lease-expiry`, `lease-renewal` and `layer-order`. The same binary executes
each scenario three times in fresh processes. A timer revokes and purges while
the low-priority queue is deliberately blocked; renewal succeeds only for the
current nonzero epoch and never enables a retired stream, including after
cleanup and after a replacement enable. The reordered layer fixture checks
current-index mask bits, exclusion below the default and a middle-layer change
that leaves the highest layer unchanged. Initial and renewal replies encode
and decode the real layer-state submessage and its presence flag.

`tests/web/lease.spec.tsx` exercises the actual App/codec with deferred replies:
tokenized renewal and unmount retirement, Disable before connection abort,
rejected renewal without auto-enable, late renewal after stop, full provisional
visualization rollback, preservation of confirmed history, initial mask-based
labels and conservative legacy/malformed-mask fallback. Existing uint32 layer
bounds and provider/index lifecycle assertions remain unchanged.

For negative controls, prepare an isolated owner source copy in container
storage and run `python3 tests/review_negative_control.py FAULT "$ISOLATED_OWNER"`
from the unchanged owner. `lease-expiry`, `late-renewal`, `default-filter` and
`layer-id-mask` must fail their corresponding real-kernel assertions.
`provisional-mark` and `inactive-fallback` must fail the unchanged Web cases.
The operator rejects the authoring owner. Preserve the first executable
assertion failure and all required repeats; compilation/link failures do not
establish a negative control. These synthetic boundaries do not prove physical
USB/BLE delivery, a held-key resynchronization guarantee or interruption of a
Studio TX call already committed by the core.
