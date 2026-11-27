# UniFFI & bindings

- Keep core logic in Rust and language wrappers thin, mirroring Rust names and semantics across target languages without adding parallel stacks beside Rust.
- Never hand-edit generated binding layers; regenerate them from Rust exports and update all handwritten wrappers, examples, and docs in the same change.
- UniFFI ignores `#[cfg]` inside an export `impl`; gate conditional exports at the module level.
- Handle open sets carefully for languages with exhaustive `switch` (Swift, Kotlin, Dart): use constructor-backed selector objects for inputs Rust can grow, and include an `Unknown` variant for outputs Rust can grow.
- Default argument values don't reach Go; resolve defaults in Rust. Where a language has no null (Go structs, C API), pair optional durations/values with an explicit boolean or zero-default semantics.
- In Python wrappers, keep the generated `_uniffi`/`_ffi` layer private, expose async context managers and `async for` iterators, extend with keyword-only args with defaults (`*, ...`), and ship `py.typed`.
- Test core native behavior once in Rust; keep wrapper tests focused on what the wrapper owns (mapping, cancellation, async adapters, lifetimes).
