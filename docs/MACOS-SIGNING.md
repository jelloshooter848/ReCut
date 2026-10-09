# Signing and notarizing the macOS build

This guide is for the person who signs ReCut for macOS: someone with a paid **Apple Developer Program** membership
(the project owner's brother). You do not need access to the ReCut repository, a Mac build setup or any knowledge of
the code. You create two credentials in your Apple account, turn them into five text values, and hand them to the
project owner, who stores them as encrypted GitHub secrets. From then on GitHub's macOS runner signs and notarizes
every macOS build by itself. **Releases need them:** macOS is an official release platform, and a release build
fails without all five secrets (see [Releases require signing](#releases-require-signing)).

It takes about 30 minutes, once. Allow a little longer if you have never used Keychain Access.

## What signing changes

| | Unsigned test build (no secrets) | Signed and notarized build (every release) |
|---|---|---|
| First launch | macOS refuses: "Apple could not verify "ReCut" is free of malware". Users must go to **System Settings › Privacy & Security** and click **Open Anyway** (on macOS 14 and earlier also: right-click the app › **Open**). | The normal one-time question "ReCut is an app downloaded from the Internet. Are you sure you want to open it?" › **Open**. No "unidentified developer" or "could not verify" warning. |
| Who vouches for it | Nobody. | Your Developer ID: Apple scanned the build for malware (notarization) and the result is stapled to the app, so it also checks out offline. |
| Your name | Not shown. | Your name (or your team's) is in the certificate, visible to anyone who inspects the signature (`codesign -dv`). |

Signing does not change what the app does, and it does not put ReCut on the Mac App Store.

## What it costs

Nothing beyond your existing Apple Developer Program membership. Developer ID certificates, notarization and App
Store Connect API keys are included. GitHub's macOS runners are free for public repositories such as ReCut.

## What you will hand over

Five values. The owner stores each as a GitHub **repository secret** with exactly this name:

| Secret name | What it holds | Where it comes from |
|---|---|---|
| `CSC_LINK` | Your "Developer ID Application" certificate and its private key, as a `.p12` file, **base64-encoded** (one long line of text). | Step 1 and 2 |
| `CSC_KEY_PASSWORD` | The password you chose when you exported the `.p12`. | Step 2 |
| `APPLE_API_KEY` | The App Store Connect API key file (`AuthKey_XXXXXXXXXX.p8`), **base64-encoded**. | Step 3 |
| `APPLE_API_KEY_ID` | The key's ID, 10 characters, for example `2X9R4HXF34`. | Step 3 |
| `APPLE_API_ISSUER` | Your team's Issuer ID, a UUID like `57246542-96fe-1a63-e053-0824d011072a`. | Step 3 |

CI uses all five or none. If only some are set, the macOS job fails on purpose rather than producing a half-signed
build.

### Releases require signing

Both dmgs (Apple Silicon and Intel) are attached to every ReCut release, and a release is never published with an
unsigned dmg. On a release run (the merge of a release PR, see [RELEASING.md](RELEASING.md)) each leg of the `macos`
job checks, in its first step, that all five secrets are set and fails at once if any is missing; later it fails
unless electron-builder signed the app with the Developer ID, Apple notarized it, Gatekeeper accepts it as
"Notarized Developer ID" and the ticket is stapled. A failed `macos` leg stops the whole release: nothing is
published and no tag is created. Fix the secrets (or the cause Apple reports) and click **Re-run failed jobs** on the
run; the version is still unreleased, so the re-run publishes it. Test builds (every run that is not a release) still
work without the secrets: they are then ad-hoc signed.

## Step 1: create a "Developer ID Application" certificate

Only the **Account Holder** of a team can create Developer ID certificates. For an individual membership that is you.
Use either route.

**Route A, with Xcode (simplest if Xcode is installed):**

1. Open Xcode › **Settings…** › **Accounts**, select your Apple ID and your team, click **Manage Certificates…**.
2. Click **+** › **Developer ID Application**. Xcode creates the certificate and puts it, with its private key, in
   your login keychain.

**Route B, in the browser and Keychain Access (no Xcode needed):**

1. On your Mac open **Keychain Access** (Applications › Utilities). Menu **Keychain Access › Certificate Assistant ›
   Request a Certificate From a Certificate Authority…**. Enter your email address and name, leave "CA Email Address"
   empty, choose **Saved to disk**, click **Continue** and save the `.certSigningRequest` file. (This also creates the
   private key in your login keychain. It never leaves your Mac except inside the `.p12` in step 2.)
2. Go to <https://developer.apple.com/account/resources/certificates/add>, sign in, choose **Developer ID
   Application**, click **Continue**. If asked for a profile type, choose **G2 Sub-CA**. Upload the
   `.certSigningRequest` file and click **Continue**, then **Download**.
3. Double-click the downloaded `developerID_application.cer`. Keychain Access adds it to your login keychain, where it
   pairs with the private key from step 1.

Check: in Keychain Access, select the **login** keychain and the **My Certificates** tab. You should see
"Developer ID Application: *Your Name* (*TEAMID*)" with a disclosure triangle that reveals a private key. If there is
no triangle, the private key is missing (the certificate was made on another Mac): repeat Route B on this Mac.

## Step 2: export it as a password-protected .p12 and base64 it

1. In Keychain Access › **My Certificates**, right-click "Developer ID Application: *Your Name* (*TEAMID*)" ›
   **Export…**. Choose the format **Personal Information Exchange (.p12)** and save it, for example as
   `DeveloperID.p12` on the Desktop.
2. Choose a strong password when asked (a password manager can generate one). This password is the
   **`CSC_KEY_PASSWORD`** value. macOS may then ask for your login password to allow the export.
3. Open **Terminal** and turn the file into one line of text, copied to the clipboard:

   ```bash
   base64 -i ~/Desktop/DeveloperID.p12 | tr -d '\n' | pbcopy
   ```

   The clipboard now holds the **`CSC_LINK`** value. Paste it straight into the secure note or message for the
   owner (see [Handing the values to the owner](#handing-the-values-to-the-owner)).

## Step 3: create an App Store Connect API key for notarization

Notarization is Apple's automated malware check. CI submits each build with an API key, so no Apple ID password or
two-factor code is involved.

1. Go to <https://appstoreconnect.apple.com/access/integrations/api> (App Store Connect › **Users and Access** ›
   **Integrations** › **App Store Connect API**) and select **Team Keys**. If it asks you to request access first,
   click **Request Access** and accept; access is granted immediately for the Account Holder.
2. Click **Generate API Key** (or **+**). Name it, for example "ReCut CI notarization". Under **Access** choose
   **Developer**. That role is enough to submit software for notarization. (Apple's documentation says notarytool
   needs a *Team* key, not an individual key, but does not name the minimum role; if CI ever reports that the key is
   not authorized to notarize, create a new key with the **App Manager** role instead. Check Apple's current page if
   in doubt: <https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api>.)
3. Click **Generate**. On the key list you now see:
   - the **Key ID** of the new key: the **`APPLE_API_KEY_ID`** value;
   - above the list, the **Issuer ID** (with a "Copy" button): the **`APPLE_API_ISSUER`** value.
4. Click **Download API Key** next to the new key. **You can download it only once**; Apple keeps no copy. You get
   `AuthKey_<KEYID>.p8`. Base64 it the same way:

   ```bash
   base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8 | tr -d '\n' | pbcopy
   ```

   The clipboard now holds the **`APPLE_API_KEY`** value. (CI also accepts the plain text of the `.p8` file, the
   lines from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----`, but base64 avoids copy-and-paste
   mistakes with line breaks.)

## Handing the values to the owner

You do not need access to the repository. Send the five values to the owner over a channel that is end-to-end
encrypted and does not keep them forever, for example a password manager's secure share (1Password, Bitwarden Send)
with an expiry, or Signal with disappearing messages. Do not use plain email, SMS, chat apps without end-to-end
encryption, or a GitHub issue or pull request. Send the `.p12` password separately from the `.p12` value if you can.

Then delete the copies you no longer need: the `.p12` and `.p8` files on your Desktop / Downloads (keep a backup of
both in your password manager if you like; the certificate also stays in your keychain), and the shared note once the
owner confirms.

## For the owner: adding the secrets

1. On GitHub open the ReCut repository › **Settings** › **Secrets and variables** › **Actions**.
2. On the **Secrets** tab click **New repository secret** five times, once per row of the
   [table above](#what-you-will-hand-over). The **Name** must match exactly (`CSC_LINK`, `CSC_KEY_PASSWORD`,
   `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); paste the value as it is, without quotes or extra spaces.
3. Delete the shared note.

GitHub encrypts secrets, shows them to nobody (not even you, after saving) and masks them in logs. Only the `macos`
job of `.github/workflows/windows.yml` reads them, for pushes, manual runs and pull requests from branches of this
repository (a pull request run is always a test build, signed like any other when the secrets are set). GitHub never
passes secrets to pull requests from forks: those runs make ad-hoc signed test builds. Pushing to the repository is
needed to change the workflow, so keep the list of people with write access short.

## Checking a signed build

1. Run the workflow (Actions › **Windows build** › **Run workflow**), or wait for the next push to `main`.
2. Both dmgs are signed with the same five secrets: the Apple Silicon one (`ReCut-<version>-macos-arm64.dmg`) and the
   Intel one (`ReCut-<version>-macos-x64.dmg`). Open the run › jobs **macOS arm64 dmg + smoke test** and
   **macOS x64 dmg + smoke test**, and in each:
   - "Code signing setup" says *All five macOS signing secrets are set*.
   - "Package the dmg" logs `signing` with your identity and, a few minutes later, `notarization successful`.
   - "Code signature" passes: every Mach-O file in ReCut.app (Electron, its helpers, the bundled `ffmpeg` and
     `ffprobe`, and the speech-to-text engine: `whisper-cli`, plus on x64 its `.dylib` libraries and
     `libggml-cpu-*.so` kernels) is signed with your Developer ID, the hardened runtime and a secure timestamp; `spctl`
     reports `source=Notarized Developer ID`; `xcrun stapler validate` finds the stapled ticket.
   - The job summary says the dmg is signed and notarized.
3. On a Mac, download the **ReCut-macos-arm64** (Apple Silicon) or **ReCut-macos-x64** (Intel) artifact of that run,
   unzip it, open the `.dmg`, drag ReCut to Applications and open it. It must open after the usual "downloaded from
   the Internet" question, with no "could not verify" warning. In Terminal you can also check:

   ```bash
   codesign --verify --deep --strict --verbose=2 /Applications/ReCut.app
   spctl -a -vv -t exec /Applications/ReCut.app        # "accepted", "source=Notarized Developer ID"
   xcrun stapler validate /Applications/ReCut.app      # "The validate action worked!"
   ```

If notarization fails, the "Package the dmg" step prints Apple's reason. The usual causes are a wrong or expired
certificate password, a certificate of the wrong type (it must be **Developer ID Application**, not "Apple
Development" or "Mac App Distribution"), or an API key that is an individual key or lacks access.

## Renewing and revoking

- **Expiry.** A Developer ID Application certificate is valid for five years; builds signed while it was valid keep
  working afterwards because each signature is timestamped. Before it expires, repeat steps 1 and 2 and give the owner
  the new `CSC_LINK` and `CSC_KEY_PASSWORD`: with an expired certificate, signing fails and so does every release.
  API keys do not expire.
- **To stop CI signing**, the owner deletes the five secrets (Settings › Secrets and variables › Actions). The next
  test builds are ad-hoc signed again, but **no release can be published** until all five are set again (the `macos`
  job fails every release run without them). Nothing already published changes.
- **If a value leaked:**
  - API key: revoke it in App Store Connect › Users and Access › Integrations › App Store Connect API (**Revoke**
    next to the key). Harmless to builds already notarized. Create a new key (step 3) and update `APPLE_API_KEY`,
    `APPLE_API_KEY_ID` (the Issuer ID stays the same).
  - Certificate: revoke it at <https://developer.apple.com/account/resources/certificates/list> (select it ›
    **Revoke**). Revoking a Developer ID certificate can stop ReCut releases signed with it from opening on users'
    Macs, so do it only if the `.p12` and its password really leaked, then make a new certificate (steps 1 and 2),
    update `CSC_LINK` and `CSC_KEY_PASSWORD`, and publish a new release.

## How it works (for maintainers)

- Packaging: `package.json` → `build.mac` (dmg named `ReCut-${version}-macos-${arch}.dmg`, arm64 by default,
  `hardenedRuntime: true`, entitlements in `build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist`,
  both only `allow-jit`).
- CI: the `macos` job in `.github/workflows/windows.yml`, a matrix with one leg per dmg (arm64, x64), each signed the
  same way with the same secrets. With all five secrets each leg writes the `.p8` to a private temp
  file, runs `electron-builder --mac dmg --arm64` (or `--x64`) with `CSC_LINK` / `CSC_KEY_PASSWORD` (electron-builder
  imports the certificate into a temporary keychain and signs every Mach-O with the hardened runtime and a timestamp,
  including `Contents/Resources/ffmpeg/ffmpeg` and `ffprobe` and everything in `Contents/Resources/whisper`; the x64
  engine's libraries load only because they carry the same Team ID as `whisper-cli`) and `APPLE_API_KEY` /
  `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`
  (electron-builder notarizes the app with `notarytool` and staples the ticket), then deletes the key file. Without
  the secrets it sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and makes an ad-hoc signed build without the hardened
  runtime.
- The dmg itself is not signed or notarized separately: the app inside it is, with the ticket stapled, which is what
  Gatekeeper checks.
- The `macos` job (both legs) and `macos-e2e` are release gates: the `publish` job needs them and attaches both dmgs.
  The `macos` job's first step, "Release run? (a release must be signed)", decides release or test build by the same
  rules as the installer job's release metadata step and fails a release run that lacks any of the five secrets; the
  "Code signing setup" and "Code signature" steps refuse an unsigned release build again.
