# Deployment kit: native mobile distribution and pairing

The deployment kit treats Happier's native Android and iOS apps as clients of the same Relay protocol as the Web client. A Web bundle is not a substitute for either native app.

`scripts/pipeline/deployment-kit/lib/deployment-kit-mobile.mjs` owns the portable mobile manifest fragment and its local receipt checks. It does not build, sign, submit, publish, install, or launch an app, and it does not contact Google, Apple, Expo, an MDM service, or a Relay.

## Distribution channels

The v1 fragment supports two mutually exclusive modes.

### External App, artifacts not included

Use this mode when the deployment kit contains only Controller and Agent artifacts and the operator will obtain the native App independently:

```json
{
  "distribution": {
    "mode": "external-app",
    "artifactInclusion": "not-included"
  },
  "android": {
    "applicationId": "dev.happier.app",
    "appVersion": "0.2.10",
    "runtimeVersion": "0.2.10",
    "channels": ["google-play"]
  },
  "ios": {
    "bundleId": "dev.happier.app",
    "appVersion": "0.2.10",
    "runtimeVersion": "0.2.10",
    "channels": ["app-store", "testflight"],
    "genericSideloadableIpa": false
  }
}
```

The generated manifest records `artifactInclusion: not-included`, artifact/signing/publication verification as `not-performed`, and channel availability/device validation as `not-verified`. It contains no APK/AAB/IPA format, build ID, signing-certificate fingerprint, Apple team ID, mobile artifact digest, or mobile receipt. The local receipt validator rejects receipts for this mode instead of turning unrelated metadata into evidence.

Channel names are acquisition guidance only. They do not prove that Google Play, App Store, TestFlight, or MDM currently offers the declared version. `requiredClaimV1AppVersion` and `requiredRuntimeVersion` are compatibility requirements copied from the kit version contract, not observations of an installed App. Mobile acceptance stays blocked until an authenticated, operator-trusted channel provides those versions and a real device passes claim-v1 pairing.

A current Relay that supports claim-v1 produces a claim-v1 QR. The Add Phone flow has no force-legacy QR action. An older App that cannot parse claim-v1 must be upgraded; it must not be described as compatible merely because it came from a trusted store.

### Signed channel artifacts

The existing signed-channel input remains supported for authenticated release pipelines. In that mode the contract follows the checked-in Expo/EAS release paths:

- Android always has a Google Play AAB build. A separately signed APK is optional and has its own build identity and signing-certificate fingerprint because Play App Signing and direct APK signing can differ.
- iOS supports App Store and TestFlight delivery through Apple-signed builds. MDM is an operator-managed Apple provisioning path and is not automated by the current pipeline.
- An iOS IPA is never declared generically sideloadable. Installation still requires an applicable Apple signing identity and App Store, TestFlight, or MDM provisioning.

Every accepted signed-channel distribution receipt must exactly match the declared application or bundle identifier, app version, Expo runtime version, supported Relay protocol version, channel, artifact format, build ID, signing-certificate SHA-256 fingerprint, artifact SHA-256, and artifact size. Platform-specific evidence sources are also fixed by channel. A receipt passing the local validator means its declared metadata matches the fragment; the caller must still obtain it through an authenticated provider or signing pipeline. The validator rejects unknown receipt fields so a token, private key, or provider credential cannot silently become part of the portable receipt contract.

## One-time pairing claim

The portable pairing contract is `claim-v1`. Its QR/deep link has exactly three query parameters:

- `v=claim-v1`: the fixed protocol discriminator;
- `claimId`: an opaque, short-lived claim identifier;
- `origin`: the canonical HTTPS Relay origin.

The link contains no access token, refresh token, account key, master secret, or long-lived pairing secret. Expiry is authoritative Relay state, not client-controlled URL metadata. Acceptance requires a matching unexpired claim and an atomic consume operation; a false, failed, unknown, or repeated consume is rejected.

The Relay, desktop/Web producer, and current App source now implement this contract. The Relay atomically accepts one matching phone request, the desktop polls the existing authenticated status endpoint, and the phone then reuses the established approval/login flow. A new client falls back to the legacy `pairId + secret + server` protocol only when claim start returns an explicit 404 or 405. Legacy endpoints remain available for old clients. An old phone App cannot parse a claim-v1 QR produced by a current Relay and must be upgraded; the current Add Phone UI does not provide a force-legacy action.

This source-level implementation has focused protocol, Relay SQLite, API, and UI tests, but it has not yet completed a real desktop-to-phone scan on signed Android/iOS builds. Deployment manifests therefore report `runtimeIntegrationStatus: implemented` together with `liveDeviceValidationStatus: not-verified`; do not describe the mobile flow as field-verified until that device gate passes.

## Push modes

- `cloud` declares APNs and FCM as external dependencies. Credentials remain outside the deployment kit.
- `private` declares no external push provider. Foreground realtime sync remains available, but background remote notifications and background wake-up are unavailable. The app resynchronizes when active; the kit must not advertise closed-app notification delivery in this mode.
