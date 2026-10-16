# Lecture Transcriber

Version **1.1.0** · Local speech review update · Verified **16 October 2026**

**[Download Lecture Transcriber for Mac (.zip)](https://github.com/Cantemir2003/ChatGPT-Codex/raw/refs/heads/main/downloads/Lecture-Transcriber.zip)**

Unzip the download, open **Start Here.html** inside the **Lecture Transcriber** folder, and follow the setup steps. After setup, double-click **Start Lecture Transcriber.command** to open the app. This version runs on a Mac; you can import recordings from iPhone Voice Memos.

The download includes the complete app, source code, setup launchers, and instructions. It requires Node.js 24, FFmpeg, and your own OpenAI API key; the guide walks through setup. It is not a signed macOS installer. Mac-specific setup and real API transcription still need testing on a Mac.

A private, local web app for transcribing university lectures with **exactly `gpt-transcribe`**. It is designed for an M3 MacBook Air and standard iPhone Voice Memos `.m4a` recordings. Its English interface starts with Romanian language hints and a short dentistry context.

Your recording stays on your Mac until you choose **Transcribe**. That action sends audio to OpenAI using your API account and prepaid credit. The app keeps the original returned text and raw responses without summarizing, translating, or rewriting them. Its reading view and TXT export add clearly marked review notes when text is missing or may be incomplete. It does not use your ChatGPT subscription.

## First-time setup

These steps are needed once. Allow time for the installers to download; you do not need to know programming.

1. **Keep the app folder together.** Unzip the download in Finder and move the `Lecture Transcriber` folder somewhere permanent, such as Documents. Do not run it inside the ZIP or move only a `.command` file.
2. **Install Node.js 24 LTS.** Open [nodejs.org/download](https://nodejs.org/en/download), choose version **24 LTS**, macOS, and the **Installer (.pkg)**. For your M3 choose **ARM64** if asked. Double-click the downloaded installer and follow its instructions. Node.js runs the app locally.
3. **Install Homebrew.** This is a common Mac tool installer used here to install FFmpeg, which reads and splits audio. Open [brew.sh](https://brew.sh), copy the installation command shown there, open **Terminal** from Applications → Utilities, paste the command, and press Return. Follow the installer. If it asks for your Mac login password, typing is invisible; type it and press Return. When Homebrew finishes, follow its printed **Next steps** to add Homebrew to your path.
4. **Install FFmpeg.** In that same Terminal window, paste `brew install ffmpeg` and press Return. Wait until the command finishes. Homebrew normally installs Apple's Command Line Tools as part of setup. If setup later reports they are missing, run `xcode-select --install` in Terminal and complete Apple's installer.
5. **Prepare the app.** In Finder, open the app folder and double-click **First-time Setup.command**. This checks the prerequisites, builds the app, and compiles its small macOS Keychain helper. Wait for **Setup complete**, then press Return. An internet connection is needed to download the pinned dependencies, including the local speech detector’s runtime. Its model is included with the app; you do not need to install Python or another speech service.
6. Double-click **Start Lecture Transcriber.command**. Your default browser opens `http://127.0.0.1:43187`. You can close the Terminal window after it says the app is running.
7. Enter your **OpenAI API key in the local app**, then save it. The app stores it in **macOS Keychain**, not in a text file or the browser. If macOS asks for Keychain access, allow the app's `keychain-helper` to access the key. Never paste your key into this chat or the Terminal.

The `.command` files are plain scripts you can inspect. If macOS blocks opening one, Control-click that specific file and choose **Open**. On newer macOS versions, open System Settings → Privacy & Security and use **Open Anyway** for that file if necessary. Do this only for the app you intended to download; you do not need to disable macOS security. If Finder says the file lacks execution permission, open Terminal, type `chmod +x ` (including the space), drag the `.command` file from Finder into Terminal, and press Return. Repeat for the three launchers if needed.

## Update an existing installation

1. Double-click **Stop Lecture Transcriber.command** in your old app folder and wait for it to stop. Closing its browser tab is not enough.
2. Download the updated ZIP and unzip it into a **separate folder**. Keep the old folder until the update works; do not mix files from the two versions.
3. Open **Start Here.html** in the new folder. If Node.js 24 and FFmpeg are already installed, go straight to **First-time Setup.command** in that folder. It installs the updated dependencies and builds this version.
4. Double-click the **Start Lecture Transcriber.command** in the new folder. Your saved lectures and Keychain key use the same Mac data location, so they are available to the updated app. Start only this version.

Back up the data folder shown below before updating. The app adds review information to existing saved jobs locally; this does not send audio to OpenAI or start a new transcription. An old job may say audio review was not run. Audio deleted by a previous version cannot be recovered by the update; keep the original Voice Memos exports.

## Get a recording from iPhone Voice Memos

1. On your iPhone, open **Voice Memos** and select the lecture.
2. Tap **…** (More), then **Share**. Keep the standard/default export; do not choose the **Editable** option. The default export is `.m4a`.
3. Choose **Save to Files** and save in iCloud Drive. On your Mac, find that file in Finder → iCloud Drive and let it finish downloading. Alternatively, use AirDrop from the Share sheet to send it directly to your Mac.

You can keep the original wherever you prefer. The app makes its own working copy. Deleting a lecture from app history never removes the original Voice Memos export. [Apple's export instructions](https://support.apple.com/guide/iphone/export-a-recording-to-files-iph831c37815/ios).

## Daily use

1. Double-click **Start Lecture Transcriber.command**. If the app is already running, this simply opens its browser window.
2. Drop a recording into the app or choose it with the file picker. You can select several; they are processed one at a time. Preview the audio and check its measured duration and estimated cost.
3. Open **Transcription settings** if needed. Romanian is selected by default. Automatic language detection omits the language hint. Add only relevant vocabulary, one term or phrase per line. Save a named preset for settings you reuse.
4. Click **Transcribe**. Keep the Mac awake and connected to the internet. The app shows preparation, request status, and completed section counts. The estimate is about **US$0.27 for one hour** or **US$0.54 for two hours** at the price checked on **14 October 2026**; retries can add cost.
5. Read the transcript and any **Review needed** notice, search it, adjust the text size, or choose **Copy all**. Choose **Export TXT** to save a UTF-8 text file named after the recording. Copy and export include the app’s review notes, so a missing section is not silently skipped. Your browser normally saves the file in **Downloads**; Romanian diacritics are preserved.
6. When finished, double-click **Stop Lecture Transcriber.command**. Closing the browser tab alone does not stop the app. Stopping or cancelling preserves completed sections; an in-flight request may still be charged.

Long files are split automatically, with nearby pauses preferred for boundaries. The original recording is never edited. The default section target is five minutes; each uploaded section is kept below 24,000,000 bytes to leave space below the documented 25 MB upload limit. These section durations are an app choice, not a claimed model limit. Temporary PCM audio can take several gigabytes for a long lecture; leave free disk space while it runs. Model text is joined in order without repetition removal. Where needed, app-generated notes identify a section that needs attention.

## Review a potentially incomplete transcription

A finished request can still return very little text. The app runs **Silero VAD**, a bundled speech detector, locally on the Mac to help flag sections worth listening to. This does not transcribe, rewrite, or send extra audio to OpenAI, and it adds no OpenAI requests. It analyzes a separate mono, 16 kHz signal; your original recording and the audio sent for transcription retain their existing quality.

A **Review needed** notice means one or more of these conditions applies:

- **No text returned:** a successful API response had empty or whitespace-only text, no text field, or an invalid text field. This is always marked, even when the detector found no speech.
- **Possibly incomplete:** a section has at least 60 seconds of locally detected speech but fewer than 10 returned words per minute of that speech. If speech detection was unavailable or not run, the fallback flags sections at least two minutes long with fewer than 10 words per minute of the full section.
- **Audio review unavailable/not run:** the local detector could not run, or the saved job predates the check. A nonempty result does not prove completeness.

Use the interval controls to listen to a flagged section. Notes show the recording filename and the section’s actual time range. They identify the **whole section**, not the exact position of any omission inside returned text. If the app’s audio copy is no longer available, open the original recording at those times. Failed requests, interrupted requests, and sections not yet processed have different notes; they are not described as successful empty responses.

These checks are prompts to review, not an accuracy score or a guarantee that all speech was transcribed. The detector can miss speech or mistake other sounds for speech. The app does not automatically retranscribe flagged sections. **Resume unfinished sections** reuses final responses, including responses marked as having no text.

## Saved lectures and recovery

Lectures and their transcripts remain in the sidebar after a refresh or restart. If a request fails or you stop the app, select the lecture and choose **Resume unfinished sections** after fixing the problem. Completed sections are reused; only unfinished sections are requested again. Partial results are labeled and can be downloaded. An unfinished streamed section is not treated as a completed response.

Data is stored on your Mac at:

```text
~/Library/Application Support/Lecture Transcriber
```

To find it, in Finder choose **Go → Go to Folder…**, paste that path, and press Return. The `jobs` folder contains one folder per lecture:

- `transcript.txt`: the reading/export version, including app review notes.
- `raw-transcript.txt`: the original returned section text, joined in order without review notes. It preserves whitespace and Romanian characters.
- `responses`: the original per-section JSON, including responses whose text was missing or invalid.
- `manifest.json`: section order, status, settings, and review information.

The API key is stored separately in Keychain. Back up the data folder if you want to preserve your history.

With **Keep working audio after completion** off, automatic cleanup happens only when the job finishes, local speech analysis ran successfully, and no section is flagged for review. Jobs needing review, including unavailable or unrun audio analysis, retain their working audio even when that setting is off. Incomplete jobs keep audio so they can resume. Turning the setting on retains other completed jobs’ audio too. Deleting a job from history deletes its app-owned data and audio copies, never your original recording.

The app's usage display is a local estimate, not your OpenAI balance or bill. A timeout can mean OpenAI processed a request but the response did not arrive; resuming may charge that section again. Check the [OpenAI usage dashboard](https://platform.openai.com/usage) for account usage.

## If something goes wrong

| Message or problem | What to do |
| --- | --- |
| FFmpeg missing | Follow the `brew install ffmpeg` step above, then start again. |
| API key invalid | Replace the key in the app's key settings. Do not include it in screenshots or support messages. |
| Insufficient credit/quota | Check your API billing and project limits, add credit if needed, then Resume. |
| No access to `gpt-transcribe` | Check that your API project can use this exact model. The app will not silently switch models. |
| Rate limit or connection problem | The app retries transient failures a limited number of times. Check your connection or wait, then Resume. |
| Recording context too long | Import the recording as a new job with shorter context. Resuming uses the existing settings snapshot. The numeric API prompt limit is unpublished. |
| Audio cannot be read | Export a fresh standard M4A from Voice Memos and ensure it has fully downloaded to the Mac. |
| Local audio review unavailable | Run the updated **First-time Setup.command** to ensure its dependencies are installed. The app retains available audio and uses the duration fallback. You can still inspect the text and listen to the recording. |
| Port 43187 already in use | Use the Stop launcher, then Start. If another app owns that port, close that app first. |
| Browser did not open | Open `http://127.0.0.1:43187` in Safari or Chrome. |
| Setup or start still fails | Read the Terminal message. Startup details are saved as `launcher.log` in the data folder above. |

You can replace or remove your API key in the app. Removing it prevents new requests and does not erase saved transcripts. History and audio are private local files; ordinary Mac backups may include them. The app has no analytics or cloud sync.

## Verification and limits

Version **1.1.0** was checked on **16 October 2026** in a Linux development environment. All **154 automated tests across six files**, type checks, the production build, production startup/shutdown checks, and the extended Chromium browser workflow passed. The light/dark interface was inspected at 1280×800, with a 390-pixel layout check. The runtime dependency audit reported zero known vulnerabilities at verification time.

Eleven detector tests ran the actual bundled Silero model on an upstream public speech fixture and generated silence, tones, stereo audio, and a two-minute stream. The browser tests used mocked speech analysis and mocked OpenAI responses to check sparse, empty, and missing final-section text deterministically. Review markers, interval playback, retained audio, raw-response preservation, cancellation, and recovery were checked, including that review adds no OpenAI requests.

**No real API key, user recording, or paid transcription was used.** The macOS installer flow, native detector runtime on Mac, Finder launchers, Keychain prompts, Safari, and M3 performance still need testing on a Mac. These checks do not establish transcription accuracy or guarantee that every omission is detected. See [development notes](docs/DEVELOPMENT.md) for the API capability table, architecture, and verification details.
