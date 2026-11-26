# ChatGPT Plan Feasibility Prototype

This isolated macOS prototype checks the provider round trip and Q&A presentation modes: connect a ChatGPT account, explicitly authorize ChatGPT plan usage, send text and an optional test image, stream the answer into the companion window, and ask a follow-up in the same local conversation. The toolbar lets you choose a floating companion or a source-adjacent window; the latter is centered before a selection and anchored to the selected rectangle afterward.

The **圈選畫面** button or `⌘⇧1` captures each connected display in memory, then opens a region selector. The full-display images are not written to disk; only the cropped selection is placed in the question composer. On macOS, screen capture requires the user's Screen Recording permission. This Electron path is a feasibility prototype; the product design still targets a Tauri implementation with native macOS capture and panels.

It uses OpenAI's Sign in with ChatGPT DevKit and the Responses API with the account's OAuth grant. It does not automate ChatGPT's website or read existing ChatGPT conversations. A successful sign-in without the `chatgpt.tokens.use.direct` grant is not enough to send a request. Model eligibility and plan limits are enforced by OpenAI.

## Run

```sh
npm install
npm run poc:chatgpt-plan
```

The app opens the system browser only after the user clicks **連接 ChatGPT**. The user can review and approve the requested plan-usage permission there. No API key is used. This prototype stores OAuth credentials through Electron `safeStorage` and keeps prompts, images, and answers in memory only; restarting or disconnecting clears the test conversation.

## Scope and license

The vendored `@siwc/local` package and its upstream license are included under `vendor/siwc-local`. This prototype modifies the upstream response input type and validation to add image content for the feasibility check. OpenAI's DevKit license is noncommercial and allows local personal experimentation; this prototype is not cleared for commercial distribution. Review the upstream license before reuse or distribution, and obtain separate permission or replace the DevKit if the product's purpose becomes commercial.

The Sign in with ChatGPT plan-usage feature is currently documented for eligible open-source projects and personal projects that run locally. Availability, eligible plans, and preview limits can change. See the current [official overview](https://developers.openai.com/siwc/token-sharing-open-source) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
