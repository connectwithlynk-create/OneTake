const { withEntitlementsPlist } = require('expo/config-plugins');

/**
 * Removes the "Sign in with Apple" entitlement
 * (com.apple.developer.applesignin) from the iOS build.
 *
 * expo-apple-authentication (an optional peer of @clerk/expo that npm keeps
 * reinstalling) auto-injects this entitlement via its own config plugin. It
 * is a paid-only Apple capability — a free/personal Apple Developer team
 * cannot sign it, so xcodebuild fails. This plugin runs last and deletes the
 * key, so the app signs on a free team. Apple sign-in is intentionally
 * unavailable here; auth is Email + Google. Re-evaluate if the project ever
 * enrolls in the paid Apple Developer Program.
 */
module.exports = function withNoAppleSignIn(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['com.apple.developer.applesignin'];
    return cfg;
  });
};
