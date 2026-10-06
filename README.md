# ScreenCast

Use an iPad as a second Windows screen, with touch input, over WiFi or USB. Free and open source, with no client app to install: the iPad just opens a page in Safari.

- **Low latency video**: H.264 via ffmpeg (Intel QSV, NVIDIA NVENC, AMD AMF, or software x264), decoded in Safari with WebCodecs. Falls back to MJPEG on plain HTTP.
- **Touch control**: tap, drag, two-finger scroll, two-finger tap to right-click, and an on-screen keyboard.
- **Extend, don't just mirror**: pair it with a virtual display driver and the iPad becomes a real extra monitor.
- **Optional USB mode**: stream over a cable instead of WiFi.

> **Host OS: Windows 10/11 only.** Monitor detection, capture and input injection use Windows APIs. The client can be any modern browser, but it is built and tested for iPad Safari.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org) 18+
- [FFmpeg](https://ffmpeg.org) on your `PATH`
- An iPad (or any device with a recent browser) on the same network
- Optional: a virtual display driver such as [virtual-display-rs](https://github.com/MolotovCherry/virtual-display-rs/releases), to get a real *extended* screen

## Quick start

```powershell
git clone https://github.com/AbhiMokkapati/screencast.git
cd screencast
.\install.ps1      # run in an Administrator PowerShell: installs Node/FFmpeg, picks a monitor, writes config
npm start
```

Prefer to do it by hand? Install Node and FFmpeg (`winget install OpenJS.NodeJS.LTS Gyan.FFmpeg`), then `npm install` and `npm start`.

The server prints something like:

```
Open on iPad Safari:
  https://192.168.1.20:9001/?t=<token>

First time on an iPad? Trust this PC once by opening:
  http://192.168.1.20:9002/
```

### One-time: trust the certificate (iPad)

Safari only enables the hardware H.264 decoder on HTTPS pages. ScreenCast creates a local certificate authority the first time it runs (in `certs/`), and you trust it once on the iPad:

1. Open the `http://…:9002/` address in Safari and tap **Download certificate**.
2. **Settings → General → VPN & Device Management** → *ScreenCast Local CA* → **Install**.
3. **Settings → General → About → Certificate Trust Settings** → turn on *ScreenCast Local CA*.
4. Open the `https://…:9001/?t=…` address.

Don't want HTTPS? Set `"https": false` (or `SCREENCAST_HTTPS=0`) and the server uses MJPEG over plain HTTP. It works everywhere, but it is heavier on bandwidth.

## Extending your desktop instead of mirroring

1. Install a virtual display driver (see Requirements). A new monitor appears in Windows Display Settings.
2. Set its resolution to match your iPad (for example 1668×1024 for an 11" iPad Pro, 2048×1366 for a 12.9").
3. Run `npm run list-displays` to find the new monitor's index, and set `monitor` in `screencast.config.json`.

## Configuration

Copy `screencast.config.example.json` to `screencast.config.json` (`install.ps1` does this for you), or use environment variables, which take priority.

| Config key | Env var | Default | Meaning |
|---|---|---|---|
| `monitor` | `MONITOR` | `1` | Monitor index to stream (see `npm run list-displays`) |
| `fps` | `FPS` | `30` | Frames per second (1–120) |
| `quality` | `QUALITY` | `5` | MJPEG quality, 2–31 (lower is better) |
| `port` | `PORT` | `9001` | Server port |
| `codec` | `CODEC` | `h264` | `h264` or `mjpeg` |
| `encoder` | `ENCODER` | `auto` | `auto`, `h264_qsv`, `h264_nvenc`, `h264_amf`, `libx264` |
| `bitrate` | `BITRATE` | `8` | H.264 bitrate in Mbit/s |
| `https` | `SCREENCAST_HTTPS` | `true` | Serve over HTTPS (needed for H.264) |
| `caPort` | `CA_PORT` | `port + 1` | Port of the certificate download page |
| `scaleW`, `scaleH` | `SCALE_W`, `SCALE_H` | native | Downscale the stream |
| `token` | `SCREENCAST_TOKEN` | random per start | Fixed access token |

## USB mode (advanced, optional)

`usb-forward.bat` tunnels the stream over a USB cable using [go-ios](https://github.com/danielpaulus/go-ios) and its kernel TUN driver. It is not bundled, so:

1. Download `go-ios` for Windows and put `ios.exe` and `wintun.dll` in `driver\go-ios\`.
2. Connect and unlock the iPad, then tap **Trust**.
3. Run `usb-forward.bat` (it asks for admin rights) and open the URL it prints.

This path depends on iOS tunnel support in go-ios, which changes between iOS releases. WiFi is the well-trodden path.

## Security: read this before exposing it

ScreenCast shows your screen **and lets whoever connects control your mouse and keyboard**.

- Every API call and WebSocket connection requires the secret token from the printed URL. Treat that URL like a password. It is random per start unless you set `token`.
- Run it only on networks you trust. Don't port-forward it or put it on the public internet.
- `certs/ca.key.pem` is the private key of your local CA. It is gitignored. Never share it. Anyone who has it could mint certificates your iPad trusts. Delete `certs/` to regenerate and re-trust.
- Request origins are checked, and the server exposes no file or shell access, but the point of the tool is remote input, so the token is your main protection.

Found a vulnerability? Please open a private security advisory on GitHub rather than a public issue.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Port 9001 is already in use` | `npm run kill-port`, or choose another `port` |
| `ffmpeg not found` | Install it and restart your terminal so `PATH` refreshes |
| Falls back to MJPEG | No working H.264 encoder found, or HTTPS is off. Try `ENCODER=libx264` |
| Safari says the connection isn't private | The CA isn't trusted yet; repeat the certificate steps |
| "Access token missing" | Open the full URL including `?t=…` |
| Wrong screen streamed | `npm run list-displays`, then set `monitor` |
| Certificate stops working after the PC's IP changes | Restart the server; it re-issues the leaf certificate for the new address |

## Development

```powershell
npm test                 # node:test suite
npm run dev              # restart on file changes
```

Layout: `server.js` (entry point), `src/` (capture, encoder, H.264 parsing, TLS, input, transport), `client/` (the page served to the iPad), `tests/`.

Contributions are welcome. Open an issue first for anything big, and please include a test with any bug fix.

## License

[MIT](LICENSE)
