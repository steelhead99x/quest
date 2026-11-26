# Rust

- Use `thiserror` for libraries and `anyhow` with `.context(...)` for binaries. Don't re-export a third-party error type unless the crate wraps that dependency.
- Use typed units (`Duration`, newtypes, enums) instead of bare numbers or `f64` seconds; prefer borrowed slices/strings for read-only inputs and consume `self` for terminal operations, relying on `Drop` over a `close` callers can forget.
- Derive `Serialize`/`Deserialize` (with `serde_with` as needed) rather than hand-writing duplicate wire shapes. Keep implementation modules private and re-export flat.
- In `poll_*` implementations, use `ready!` (with `?` for `Result` polls) instead of matching `Poll::Pending`, and preserve wakeups and cancellation.
- Apply `#[non_exhaustive]` deliberately to extensible public error enums, enums that will gain variants, and `Config`-style structs with `pub` fields. Append new variants to public fieldless enums so implicit discriminants don't shift.
- Declare workspace dependencies with `{ workspace = true }`, except internal dev-dependencies that stay path-only for publishing.
- Default features skip anything expensive to build or needing a system library; gate the dependency rather than the logic so tests stay in the merge gate.
- Put local unit tests inline (`#[cfg(test)] mod tests`) and full session/transport tests in `tests/`. Mock time in unit tests; use real time only when driving real sockets, devices, or processes. Run tests through `just` (nextest when configured), not raw `cargo test`.
