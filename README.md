# Relay

Built with [Agent Duel](https://github.com/bottomless/agent-duel)

Relay sends files directly between your devices. There is no account and no cloud storage.

Open this site on two devices. Enter one device’s code on the other device. Drop files, then accept the transfer. Download each file on the receiving device.

## Privacy

WebRTC encrypts each transfer. A public PeerJS server only helps the devices find each other. It does not store your files. You confirm every incoming transfer. Keep both tabs open. Each transfer supports up to 2 GB, within available browser memory.

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
