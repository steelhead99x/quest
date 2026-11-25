// Install the service worker, so the site opens offline to its last pages.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
