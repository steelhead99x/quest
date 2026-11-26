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
warm. For each it reports the median and 95th percentile of first
contentful paint, load, the Worker's own time from `Server-Timing`, and
bytes transferred, whether it installs to the home screen and opens
offline, and light and dark screenshots. The page's own Navigation Timing
is checked against the driver's clock around each load, and loads where the
two disagree are counted.

Without `--record`, each device compares with `bench/<kind>-<model>.json`
and exits 1 on a regression beyond three times the run-to-run spread (and
a small floor per metric). `--record` writes that file instead. A run
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
worker's cache.

Sign each device's browser in to the site once before benching signed-in
pages.
