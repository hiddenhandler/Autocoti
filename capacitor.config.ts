// Capacitor wrapper for the iOS / Android apps (install @capacitor/cli + platforms when ready:
//   npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/ios @capacitor/android
//   npm run build && npx cap add ios && npx cap add android && npx cap sync).
// The app is a static SPA talking to Supabase over HTTPS, so it runs unchanged in the webview.
const config = {
  appId: 'com.barberngo.app',
  appName: 'BarberNGo',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  ios: { contentInset: 'always' },
}

export default config
