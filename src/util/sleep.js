// Block synchronously for `ms` without shelling out — portable across platforms.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
