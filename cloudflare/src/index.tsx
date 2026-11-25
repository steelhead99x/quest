// The Worker's entry. It exports only the handler: workerd takes every named
// export of this module as an entrypoint, so the app and its helpers live in app.tsx.
import { app } from "./app.tsx";

export default app({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });
