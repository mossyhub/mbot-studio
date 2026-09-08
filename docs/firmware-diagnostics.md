# Native-boundary firmware diagnostics

The application reports `diagnostic_revision: native-boundary-v1` while retaining the existing `mbot-av-control-v1` command contract. Exact application SHA identifies the installed artifact.

## Recorded evidence

- Boot: raw `machine.reset_cause()` plus available named constants, boot identity, application SHA and uptime. Missing/failed APIs produce an explicit error. A manual restart's reset cause does not reconstruct an earlier electrical cutoff.
- `native_before`: original run ID, expanded block path, command, boot/build/SHA and uptime. The message is published first; execution is deferred until a later outer OTA tick.
- `native_after`: same operation identity and elapsed milliseconds, emitted only after the native driver returns. This is not measured physical motion.
- `native_exception`: bounded exception evidence published best-effort before attempting recovery Stop. A power loss or native nonreturn cannot emit an after/error record.
- Battery context comes from an existing sensor scan, with its sample timing; there is no continuous polling or voltage/current measurement.

The Studio recorder retains received `robot/log` messages on the server, so robot power loss does not erase evidence already received. QoS0 publication is not proof of durable server receipt. No per-operation robot flash writes, guessed ADC/register reads, watchdog weakening or changes to resident-loader recovery are used.

Stop, standalone Stop, disconnect and context replacement invalidate prepared actions before dispatch. Native calls retain the shallow `ota_step → IO.execute` stack. Completion events for native operations are not transmitted before the driver returns.

## Startup acceptance

The larger direct-source candidate and a whitespace-reduced candidate did not survive startup on the commissioning device; the loader restored the previous confirmed application. A nonmoving probe reported `before_compile` and then lost responsiveness during execution of the candidate source, before initialization. This narrows the boundary but does not prove an exact watchdog/stack cause.

The staged packaging option compiles complete top-level source sections across OTA ticks, with shared globals and unchanged application code. It initializes only after every section compiles, then installs the actual target step function directly to avoid adding a native-call frame. Source sections and emitted package are validated by the builder. A loader `healthy:true` during staging is **not** application readiness: require the actual robot status with the expected SHA/revision and successful nonmoving operations before confirming a trial.

## Installed acceptance

Built with:

```sh
python tools/build-robot-control.py --dense --staged --config /private/operator.json --out /private/new-app.py
```

The commissioning device selected and explicitly confirmed the 19,534-byte artifact with SHA-256 `75118ff839b003ae6df751b51de2ef2f94ab12f96ef04cc285fb7ca629cc76bb`. The production builder reproduced the exact bytes. A second controlled restart retained the same confirmed digest and diagnostic revision.

Nonmoving acceptance exercised LCD text, volume, a tone, LEDs, OTA status during a wait, emergency cancellation and a following successful program. Real device messages contained original-index before/after markers and elapsed times; boot diagnostics reported raw5 with the device's SOFT_RESET constant5 during the controlled restart. Studio's actual Diagnostics download contained the new boot/native records and reported healthy persistence. Sensor scans remained explicit and returned no driver errors. Last battery snapshot was30%; additional motor trials were deferred until charging.

This establishes startup, nonmoving native-boundary logging, cancellation/restart and recorder integration—not a reproduction or diagnosis of the electrical shutdown, calibrated movement, or measured voltage. The resident loader and8s watchdog settings were unchanged. The previous confirmed application was saved externally as a restorable OTA artifact.

Physical startup, command/cancellation, diagnostic retention and exact confirmed digest are separate from host tests.
