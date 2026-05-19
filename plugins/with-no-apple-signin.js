const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Force the iOS entitlements file to be empty.
 *
 * Two separate config plugins inject the Sign in with Apple capability
 * (com.apple.developer.applesignin): expo-apple-authentication's
 * withAppleAuthIOS and @clerk/expo's withClerkAppleSignIn. Both run via
 * `withEntitlementsPlist`, and relying on plugin/mod ordering to strip the
 * key after them has proven unreliable across `expo prebuild --clean` runs.
 *
 * A `withDangerousMod` runs at the very end of the iOS prebuild pipeline,
 * after every entitlements modifier. We rewrite the generated
 * `*.entitlements` file with a known-good empty plist - guaranteed to remove
 * the applesignin entry no matter who added it.
 *
 * Apple Sign-In is intentionally unavailable here (free Apple Developer
 * team can't sign that entitlement). Auth is Email + Google. Remove this
 * plugin if/when the project enrolls in the paid Apple Developer Program.
 */
const EMPTY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
  </dict>
</plist>
`;

module.exports = function withNoAppleSignIn(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const iosDir = path.join(cfg.modRequest.projectRoot, 'ios');
      try {
        for (const entry of fs.readdirSync(iosDir)) {
          const sub = path.join(iosDir, entry);
          if (!fs.statSync(sub).isDirectory()) continue;
          const ent = path.join(sub, `${entry}.entitlements`);
          if (fs.existsSync(ent)) {
            fs.writeFileSync(ent, EMPTY_ENTITLEMENTS, 'utf8');
          }
        }
      } catch (e) {
        // Don't fail prebuild over this; the file may be hand-edited later.
        console.warn('with-no-apple-signin skipped:', e.message);
      }
      return cfg;
    },
  ]);
};
