# TypeScript

- Validate only data crossing a trust boundary (wire, JSON/schemas, user input, element attributes); don't add runtime checks for misuse TypeScript's types already rule out.
- Make `close()` / teardown paths idempotent and clean up streams, timers, and listeners explicitly. Never `Promise.race` a long-lived promise (such as `closed`): losing handlers stay attached until it settles.
- Declare every imported package in the consuming package's `package.json`; workspace hoisting hides missing dependencies from local checks.
- Export only the supported public API from entrypoints, document it with TSDoc, and include declaration emit / build in checks (`--noEmit` misses declaration errors).
- Exercise browser and UI changes in a real browser (load the page, run the interaction, check the console); type checks and DOM mocks cannot verify real runtime or media behavior.
