import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.smic.bangdbmanager',
  appName: 'BangDB Manager',
  webDir: 'dist',
  // Allow plain http:// BangDB servers on a LAN from the native shells.
  server: { androidScheme: 'http', cleartext: true },
  plugins: { CapacitorHttp: { enabled: true } }
};

export default config;
