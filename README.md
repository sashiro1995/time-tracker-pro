# Time Tracker Pro

A desktop app for Windows that tracks where your time goes. Run timers, pomodoros or a stopwatch against your own categories, set goals, and see the results in charts. It can also be driven from an Ajazz AKP03E Stream Deck.

Everything stays on your computer. There is no account and no cloud sync.

## Features

- **Dashboard:** today's total, a 24-hour timeline of your sessions, your goals, and the current week.
- **Analytics:** totals, hours over time, share by category, and a weekday-by-hour heatmap, for any date range.
- **Goals:** daily, weekly, monthly or yearly targets, plus a total-hours goal with an optional date.
- **Timer, Pomodoro and Stopwatch:** several timers can run at once, with global keyboard shortcuts and custom alert sounds.
- **Log:** every session grouped by day, with CSV export.
- **Notes:** quick notes that save automatically and can become tracked categories.

## Install

1. Open the [Releases page](https://github.com/sashiro1995/time-tracker-pro/releases) and download `Time-Tracker-Pro-Setup-x.x.x.exe`.
2. Run it. The installer isn't code-signed, so Windows SmartScreen may warn you: choose **More info**, then **Run anyway**.

Closing the window keeps the app running in the system tray. To exit fully, right-click the tray icon and choose **Quit**.

## Updates

The app checks GitHub when it opens and once a day while running, and tells you when a new version is out. Nothing downloads or installs until you choose to, under **Settings → Updates**. Your data stays as it is.

If you run from source, update with `git pull`, then `npm install`.

## Run from source

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run app
```

To build the installer into `dist/`, run `npm run build`.

## Good to know

- **Internet:** charts, icons and the font load from public CDNs, so the app needs a connection to display properly.
- **Port 3000:** the app runs a small local server on this port. If another program is using it, the app tells you which one and waits for you to close it.
- **Your data:** the installed app keeps it in `%APPDATA%\Time Tracker Pro\data`. When run from source, it's in `data/`. Git ignores that folder.

## Stream Deck

For the Ajazz AKP03E, run `node stream-dock-plugin/setup.js` to install the plugin, then restart Stream Dock. Buttons can also call the local API directly:

| Action | URL |
| --- | --- |
| Start | `http://localhost:3000/api/timer/start?duration=1800&category=work` |
| Pause | `http://localhost:3000/api/timer/pause` |
| Stop | `http://localhost:3000/api/timer/stop` |
| Status | `http://localhost:3000/api/timer/status` |

## License

[ISC](LICENSE)
