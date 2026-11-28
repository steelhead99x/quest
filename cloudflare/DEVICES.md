# Device bench

`scripts/device-bench.ts` loads pages of the site on an Android phone and an
iPad attached to this computer over USB, and prints a Markdown report for a
PR's `## Validation`. It measures real browser engines on real hardware:
Chrome on Android, and Safari's WebKit on the iPad.

```sh
cd cloudflare
bun run device-bench --url https://quest.example.dev/ --url https://quest.example.dev/repos/owner/name \
  [--device android] [--device ipad] [--runs 5] [--shots ../.tmp/shots] [--record]
```

Each page loads `--runs` times cold (HTTP cache, service worker, and site
storage cleared; cookies kept, so a signed-in device stays signed in) and
warm. A load that ends anywhere but the page asked for, such as GitHub's
sign-in after the session expired, fails the run, and the iPad clears
storage only on the site's own origin. A warm load waits, untimed, for the
service worker to control the page; when none takes control within ten
seconds, that warm load is skipped and the report counts it. A page left
with fewer than three warm loads reports its cold results only, and is
neither compared nor recorded warm (`--record` keeps its earlier warm
baseline). For each it reports the median and 95th percentile of first
contentful paint, load, the Worker's own time from `Server-Timing`, and
bytes transferred, whether it installs to the home screen and opens
offline, and light and dark screenshots. The page's own Navigation Timing
is checked against the driver's clock around each load, and loads where the
two disagree are counted.

Offline checks take the page and each of its service workers offline
through Chrome's browser endpoint: a page's own offline switch leaves its
service worker's fetches on the network. The report's offline column says
what opened: `yes` for the page itself from the worker's cache, `notice
only` for the site's offline notice (which marks its `<html>` with
`data-offline-notice`, and which signed-in pages always get), or `no`.

Without `--record`, each device compares with `bench/<kind>-<model>.json`
and exits 1 when a median grew by more than three times the baseline's
run-to-run spread (and a small floor per metric), or when this run's own
spread is so wide its median can't be trusted, which needs a rerun.
`--record` writes that file instead. A run
refuses a device that is throttling or below 20% battery, and a baseline
from a different OS or browser version, so results compare like with
like. Every requested device must be attached; a missing one fails the run.

## Setup

Android: install `adb` (Android platform tools), turn on USB debugging,
accept this computer's key on the phone, and have Chrome installed. The
bench changes the phone's font scale to its largest for screenshots and
restores it after.

iPad: install libimobiledevice (`idevice_id`, `ideviceinfo`) and
`ios_webkit_debug_proxy`, trust this computer on the iPad, turn on
Settings, Apps, Safari, Advanced, Web Inspector, and leave Safari open with
one tab. iPadOS does not let the inspector set text size, cut the network,
or read thermal state, so the report says so: set Larger Text by hand
before screenshots; offline is checked as the page being in the service
worker's cache, else the notice when the worker keeps it. Dark mode goes through WebKit's
`Page.overrideUserPreference`; an iPadOS whose inspector lacks it fails the
screenshot with that reason. A cold load first opens the page so the
service worker and caches are cleared on its own origin, and waits for
that before measuring.

Sign each device's browser in to the site once before benching signed-in
pages.
