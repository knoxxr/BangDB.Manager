/** Where the UI is running: the desktop shell has its own proxy on the same origin. */
export const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
