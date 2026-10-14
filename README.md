# Relay

Built with [Agent Duel](https://github.com/bottomless/agent-duel)

Relay sends files directly between your devices. There is no account and no cloud storage.

Open this site on two devices. Enter one device’s code on the other device. Press “Add files or folders”, or drop them in, then accept the transfer on the other device. In the Receive card, choose a save folder, or download the files from Transfers.

## Privacy

WebRTC encrypts each transfer. A public PeerJS server only helps the devices find each other. It does not store your files. You confirm every incoming transfer. Keep both tabs open. There is no fixed total size limit. Files move one by one. Each file must fit in the free space on the receiving device, and Relay shows that space before you send. Chrome, Edge, and Opera on a computer can write received files straight into a folder that you choose. Other browsers, such as Safari and Firefox, do not let websites write into a folder. In those browsers, download the files one by one, or all together as a ZIP file that keeps the folders.

## Screen and background

Relay keeps your screen on while a transfer runs. A phone then does not lock in the middle of a transfer. Browsers with the Screen Wake Lock API use it. Other browsers play a hidden, muted video to hold the screen. Turn the feature off in Settings under "Keep the screen on".

A transfer keeps running when the tab is in the background. Time in the background does not count against a transfer. If the browser suspends the tab, open Relay again and the transfer resumes.

## Develop

```bash
npm ci
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the local site |
| `npm run build` | Typecheck and build the static site |
| `npm run preview` | Serve the build |
| `npm run lint` | Lint the source |
| `npm run typecheck` | Check TypeScript |
| `npm test` | Run unit tests |
| `npm run test:e2e` | Run the browser test |

The production build is a static site. GitHub Pages can host it.
